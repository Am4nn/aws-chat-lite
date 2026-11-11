import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { conditionFailed, docClient, failedAt, queryAll, setFields, tableName, transactionConflict } from "../lib/db.js";
import { Forbidden, NotFound, ValidationError } from "../lib/errors.js";
import { counterKey, roomKey } from "../lib/keys.js";
import { requireMember } from "../chat/membership.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { BUILT_IN } from "../agents/model.js";
import { can, type Role } from "../rooms/access.js";
import type { Schedule } from "../threads/types.js";
import { nextFire, parseCadence } from "./cadence.js";
import { DEFAULT_TIME_ZONE, roomTimeZone } from "./zone.js";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type ScheduleInput = { agentId: unknown; title: unknown; prompt: unknown; cadence: unknown; chatId: unknown };
type SchedulePatch = Partial<Omit<ScheduleInput, "agentId"> & { enabled: unknown }>;

const MAX_SCHEDULES = 5;
/** Well past Scheduler's last retry of an occurrence (an hour), after which no duplicate can arrive. */
const FIRE_CLAIM_TTL_SEC = 7 * 86_400;
const CONFLICT_ATTEMPTS = 3;

const nowIso = () => new Date().toISOString();
const metaKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "META" });
const scheduleKey = (roomId: string, id: string) => ({ pk: roomKey(roomId), sk: `SCHED#${id}` });
const toSchedule = ({ pk: _pk, sk: _sk, ...rest }: Record<string, unknown>) => rest as Schedule;
const idOf = (raw: unknown) => (typeof raw === "string" ? raw : "");

function titleOf(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (title.length < 1 || title.length > 40) throw new ValidationError("Schedule titles are 1 to 40 characters.");
  return title;
}

function promptOf(raw: unknown): string {
  const prompt = typeof raw === "string" ? raw.trim() : "";
  if (prompt.length < 1 || prompt.length > 2000) throw new ValidationError("A schedule's prompt is 1 to 2,000 characters.");
  return prompt;
}

function enabledOf(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new ValidationError("enabled must be true or false.");
  return raw;
}

/**
 * The room's schedules (single table, `SCHED#<id>` in the room partition). The item is the truth about a schedule;
 * EventBridge only triggers it. Member methods check the caller; the server-side ones are for the routes' follow-ups
 * and the fire handler.
 */
export function schedulesRepo() {
  const db = docClient();
  const TableName = tableName();

  /** Two transactions on the room's counter at once can cancel each other instead of one failing its condition. */
  async function transact(TransactItems: TransactItem[]) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await db.send(new TransactWriteCommand({ TransactItems }));
      } catch (e) {
        if (!transactionConflict(e) || attempt === CONFLICT_ATTEMPTS) throw e;
      }
    }
  }

  const changed = (roomId: string) =>
    bestEffort("schedules.changed broadcast", () => broadcastToRoom(roomId, { type: "schedules.changed", roomId }));

  /** The counter counts disabled schedules too, so switching one on never needs a free slot. */
  const claimSlot = (roomId: string): TransactItem => ({
    Update: {
      TableName, Key: metaKey(roomId), UpdateExpression: "ADD scheduleCount :one",
      ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(scheduleCount) OR scheduleCount < :max)",
      ExpressionAttributeValues: { ":one": 1, ":max": MAX_SCHEDULES },
    },
  });

  /** A people chat's counter names its room; a thread's also has `kind`. */
  const chatCheck = (roomId: string, chatId: string): TransactItem => ({
    ConditionCheck: {
      TableName, Key: counterKey(chatId), ConditionExpression: "roomId = :r AND attribute_not_exists(#kind)",
      ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: { ":r": roomId },
    },
  });

  const agentCheck = (roomId: string, agentId: string): TransactItem => ({
    ConditionCheck: {
      TableName, Key: { pk: roomKey(roomId), sk: `AGENT#${agentId}` },
      ConditionExpression: "attribute_exists(pk) AND NOT deleted = :t", ExpressionAttributeValues: { ":t": true },
    },
  });

  /** Fails at item 0 when the room is full; `checks` follow it. */
  const insert = (roomId: string, schedule: Schedule, checks: TransactItem[]) => transact([
    claimSlot(roomId),
    ...checks,
    { Put: { TableName, Item: { ...scheduleKey(roomId, schedule.scheduleId), ...schedule }, ConditionExpression: "attribute_not_exists(pk)" } },
  ]);

  /** False when it was already gone. */
  async function deleteSchedule(roomId: string, id: string): Promise<boolean> {
    try {
      await transact([
        { Delete: { TableName, Key: scheduleKey(roomId, id), ConditionExpression: "attribute_exists(pk)" } },
        { Update: { TableName, Key: metaKey(roomId), UpdateExpression: "ADD scheduleCount :minus", ExpressionAttributeValues: { ":minus": -1 } } },
      ]);
      return true;
    } catch (e) {
      if (failedAt(e, 0)) return false;
      throw e;
    }
  }

  async function get(roomId: string, id: string): Promise<Schedule | null> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: scheduleKey(roomId, id), ConsistentRead: true }));
    return Item ? toSchedule(Item) : null;
  }

  async function all(roomId: string): Promise<Schedule[]> {
    const items = await queryAll({
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ConsistentRead: true,
      ExpressionAttributeValues: { ":p": roomKey(roomId), ":s": "SCHED#" },
    });
    return items.map(toSchedule).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function timeZoneOf(roomId: string): Promise<string> {
    const { Item } = await db.send(new GetCommand({
      TableName, Key: metaKey(roomId), ConsistentRead: true, ProjectionExpression: "#tz", ExpressionAttributeNames: { "#tz": "timeZone" },
    }));
    return (Item?.timeZone as string | undefined) ?? DEFAULT_TIME_ZONE;
  }

  const withNext = (s: Schedule, tz: string): Schedule =>
    s.enabled ? { ...s, nextAt: new Date(nextFire(s.cadence, tz, Date.now())).toISOString() } : s;

  /** The schedule, if the caller made it or may manage the room's agents and schedules. */
  async function changeable(user: User, role: Role, roomId: string, id: string): Promise<Schedule> {
    const schedule = await get(roomId, id);
    if (!schedule) throw new NotFound("No such schedule.");
    if (schedule.createdBy !== user.userId && !can("manageAgents", role)) {
      throw new Forbidden("Only its creator or an admin can change this schedule.");
    }
    return schedule;
  }

  /** A schedule deleted meanwhile has nothing to update. */
  async function setField(roomId: string, id: string, field: "enabled" | "lastRun", value: unknown) {
    try {
      await db.send(new UpdateCommand({
        TableName, Key: scheduleKey(roomId, id), UpdateExpression: "SET #f = :v", ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#f": field }, ExpressionAttributeValues: { ":v": value },
      }));
    } catch (e) {
      if (conditionFailed(e)) return;
      throw e;
    }
    await changed(roomId);
  }

  return {
    get,
    timeZoneOf,

    async list(user: User, roomId: string) {
      await requireMember(roomId, user.userId);
      const [schedules, timeZone] = await Promise.all([all(roomId), timeZoneOf(roomId)]);
      return { schedules: schedules.map((s) => withNext(s, timeZone)), timeZone, max: MAX_SCHEDULES };
    },

    /** The agent and the people chat are checked in the same transaction that takes the slot, so neither can vanish in between. */
    async create(user: User, roomId: string, input: ScheduleInput): Promise<Schedule> {
      const fields = { title: titleOf(input.title), prompt: promptOf(input.prompt), cadence: parseCadence(input.cadence) };
      const agentId = idOf(input.agentId);
      const chatId = idOf(input.chatId);
      await requireMember(roomId, user.userId, { writing: true });
      const schedule: Schedule = {
        scheduleId: randomUUID(), agentId, ...fields, chatId, enabled: true,
        createdBy: user.userId, createdByName: user.username, createdAt: nowIso(),
      };
      try {
        // The built-in has no item until an admin edits it, so there is nothing to check it against.
        await insert(roomId, schedule, [chatCheck(roomId, chatId), ...(agentId === BUILT_IN.agentId ? [] : [agentCheck(roomId, agentId)])]);
      } catch (e) {
        if (failedAt(e, 0)) throw new ValidationError("A room has at most 5 schedules.");
        if (failedAt(e, 1)) throw new NotFound("Chat not found.");
        if (failedAt(e, 2)) throw new NotFound("No such agent.");
        throw e;
      }
      await changed(roomId);
      return withNext(schedule, await timeZoneOf(roomId));
    },

    async update(user: User, roomId: string, id: string, patch: SchedulePatch): Promise<Schedule> {
      const fields: Partial<Schedule> = {
        ...(patch.title !== undefined && { title: titleOf(patch.title) }),
        ...(patch.prompt !== undefined && { prompt: promptOf(patch.prompt) }),
        ...(patch.cadence !== undefined && { cadence: parseCadence(patch.cadence) }),
        ...(patch.chatId !== undefined && { chatId: idOf(patch.chatId) }),
        ...(patch.enabled !== undefined && { enabled: enabledOf(patch.enabled) }),
      };
      const role = await requireMember(roomId, user.userId, { writing: true });
      const current = await changeable(user, role, roomId, id);
      const names = Object.keys(fields);
      if (names.length) {
        try {
          await transact([
            {
              Update: {
                TableName, Key: scheduleKey(roomId, id), ConditionExpression: "attribute_exists(pk)",
                ...setFields(fields),
              },
            },
            ...(fields.chatId !== undefined ? [chatCheck(roomId, fields.chatId)] : []),
          ]);
        } catch (e) {
          if (failedAt(e, 0)) throw new NotFound("No such schedule.");
          if (failedAt(e, 1)) throw new NotFound("Chat not found.");
          throw e;
        }
        await changed(roomId);
      }
      return withNext({ ...current, ...fields }, await timeZoneOf(roomId));
    },

    async remove(user: User, roomId: string, id: string) {
      const role = await requireMember(roomId, user.userId, { writing: true });
      await changeable(user, role, roomId, id);
      if (!(await deleteSchedule(roomId, id))) throw new NotFound("No such schedule.");
      await changed(roomId);
    },

    /** The ids removed, so their EventBridge schedules can go too. */
    async removeForAgent(roomId: string, agentId: string): Promise<string[]> {
      const removed: string[] = [];
      for (const { scheduleId } of (await all(roomId)).filter((s) => s.agentId === agentId)) {
        if (await deleteSchedule(roomId, scheduleId)) removed.push(scheduleId);
      }
      if (removed.length) await changed(roomId);
      return removed;
    },

    /** Copies arrive switched off, posting into `chatId`, for as long as the room has free slots. */
    async createCopies(
      roomId: string, schedules: Pick<Schedule, "agentId" | "title" | "prompt" | "cadence" | "createdBy" | "createdByName">[], chatId: string,
    ) {
      let copied = 0;
      for (const s of schedules) {
        const copy: Schedule = {
          scheduleId: randomUUID(), agentId: s.agentId, title: s.title, prompt: s.prompt, cadence: s.cadence, chatId,
          enabled: false, createdBy: s.createdBy, createdByName: s.createdByName, createdAt: nowIso(),
        };
        try {
          await insert(roomId, copy, []);
        } catch (e) {
          if (failedAt(e, 0)) break;
          throw e;
        }
        copied++;
      }
      if (copied) await changed(roomId);
      return { copied, skipped: schedules.length - copied };
    },

    setEnabled: (roomId: string, id: string, enabled: boolean) => setField(roomId, id, "enabled", enabled),

    recordRun: (roomId: string, id: string, lastRun: NonNullable<Schedule["lastRun"]>) => setField(roomId, id, "lastRun", lastRun),

    /**
     * Scheduler delivers at least once, so a retry can bring an occurrence that already ran. The first fire to write
     * the occurrence's claim acts; any other finds it and does nothing.
     */
    async claimFire(roomId: string, id: string, at: string): Promise<boolean> {
      try {
        await db.send(new PutCommand({
          TableName, ConditionExpression: "attribute_not_exists(pk)",
          Item: { pk: roomKey(roomId), sk: `SCHEDFIRE#${id}#${at.slice(0, 16)}`, ttl: Math.floor(Date.now() / 1000) + FIRE_CLAIM_TTL_SEC },
        }));
        return true;
      } catch (e) {
        if (conditionFailed(e)) return false;
        throw e;
      }
    },

    async setTimeZone(user: User, roomId: string, raw: unknown): Promise<string> {
      const timeZone = roomTimeZone(raw);
      const role = await requireMember(roomId, user.userId, { writing: true });
      if (!can("setTimeZone", role)) throw new Forbidden("Only admins can set the room's time zone.");
      await db.send(new UpdateCommand({
        TableName, Key: metaKey(roomId), UpdateExpression: "SET #tz = :tz", ExpressionAttributeNames: { "#tz": "timeZone" }, ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":tz": timeZone },
      }));
      await changed(roomId);
      return timeZone;
    },
  };
}
