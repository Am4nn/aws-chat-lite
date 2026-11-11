import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentsRepo } from "../agents/repo.js";
import { budgetRepo } from "../budget/repo.js";
import type { User } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { docClient, tableName } from "../lib/db.js";
import { roomKey } from "../lib/keys.js";
import { chatRepo } from "../chat/repo.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { startOrSteer } from "../runs/start.js";
import { threadsRepo } from "../threads/repo.js";
import type { Agent, Budget, Schedule } from "../threads/types.js";
import { fireAt, threadNameFor } from "./cadence.js";
import { schedulesRepo } from "./repo.js";
import { scheduleTrigger } from "./scheduler.js";
import { DEFAULT_TIME_ZONE } from "./zone.js";

type FireInput = { roomId: string; scheduleId: string; at: unknown };
type Outcome = "retired" | "duplicate" | "skipped" | "started";

export interface FireDeps {
  schedules: Pick<ReturnType<typeof schedulesRepo>, "get" | "setEnabled" | "claimFire" | "recordRun">;
  trigger: Pick<ReturnType<typeof scheduleTrigger>, "remove">;
  agent: (roomId: string, agentId: string) => Promise<Pick<Agent, "agentId"> & { deleted?: boolean } | null>;
  room: (roomId: string) => Promise<{ archived: boolean; timeZone: string } | null>;
  budget: (roomId: string) => Promise<Pick<Budget, "spentMicros" | "capMicros">>;
  /** Posts the schedule's card, opens its thread and starts the run; the thread's number. */
  open: (roomId: string, schedule: Schedule, occurrence: string, tz: string) => Promise<number>;
}

/** Who a schedule's card and first thread message are by. `schedule` is reserved, so no person can sign up as it. */
const SCHEDULE_AUTHOR: User = { userId: "schedule", username: "schedule" };
const BUDGET_SPENT = "Skipped: the room's budget is spent.";

/**
 * One fire of a room schedule. The item is the truth, so a fire that finds the schedule gone, off, or pointing at a
 * deleted agent or an archived room deletes its own trigger instead of running. Scheduler delivers at least once, so
 * each occurrence is claimed before anything is written; a crash after the claim loses that occurrence rather than
 * running it twice. A room whose budget is spent gets a note on the schedule, not a thread that would stop at once.
 */
export async function fireSchedule({ roomId, scheduleId, at }: FireInput, deps: FireDeps): Promise<Outcome> {
  const [schedule, room] = await Promise.all([deps.schedules.get(roomId, scheduleId), deps.room(roomId)]);
  const agent = schedule && await deps.agent(roomId, schedule.agentId);
  if (!schedule?.enabled || !room || room.archived || !agent || agent.deleted) {
    await deps.trigger.remove(scheduleId);
    if (schedule?.enabled) await deps.schedules.setEnabled(roomId, scheduleId, false);
    return "retired";
  }
  const occurrence = fireAt(at, schedule.cadence, room.timeZone, Date.now());
  if (!await deps.schedules.claimFire(roomId, scheduleId, occurrence)) return "duplicate";
  const budget = await deps.budget(roomId);
  if (budget.spentMicros >= budget.capMicros) {
    await deps.schedules.recordRun(roomId, scheduleId, { at: occurrence, skipped: BUDGET_SPENT });
    return "skipped";
  }
  const threadNumber = await deps.open(roomId, schedule, occurrence, room.timeZone);
  await deps.schedules.recordRun(roomId, scheduleId, { at: occurrence, threadNumber });
  return "started";
}

async function roomState(roomId: string) {
  const { Item } = await docClient().send(new GetCommand({
    TableName: tableName(), Key: { pk: roomKey(roomId), sk: "META" }, ConsistentRead: true, ProjectionExpression: "archived, timeZone",
  }));
  return Item ? { archived: !!Item.archived, timeZone: (Item.timeZone as string | undefined) ?? DEFAULT_TIME_ZONE } : null;
}

/**
 * The card goes into the schedule's chat first, so the thread can point back at it as its source. The schedule
 * author isn't a member, so its texts skip `admit`: the schedule's own rules already checked them. The card is linked
 * before the run starts, so a start that fails still leaves it pointing at its thread.
 */
async function openThread(roomId: string, schedule: Schedule, occurrence: string, tz: string): Promise<number> {
  const chat = chatRepo();
  const { chatId, title, prompt } = schedule;
  const clientId = `${schedule.scheduleId}#${occurrence}`;
  const card = await chat.send(SCHEDULE_AUTHOR, { roomId, chatId, clientId, text: title }, { text: title, attachments: [] }, { system: true });
  await bestEffort("message.new broadcast", () => broadcastToRoom(roomId, { type: "message.new", message: card }));
  const { thread, message } = await threadsRepo().createThread(SCHEDULE_AUTHOR, roomId, {
    text: prompt, clientId: `${clientId}:t`, from: { chatId, seq: card.seq }, admitted: { text: prompt, attachments: [] },
    agentId: schedule.agentId, name: threadNameFor(title, Date.parse(occurrence), tz), system: true,
  });
  const linked = await chat.linkThread(card, { threadId: thread.threadId, kind: "started" });
  await bestEffort("message.updated broadcast", () => broadcastToRoom(roomId, { type: "message.updated", message: linked }));
  await startOrSteer(SCHEDULE_AUTHOR, roomId, thread.threadId, message);
  return thread.number;
}

function liveDeps(): FireDeps {
  return {
    schedules: schedulesRepo(),
    trigger: scheduleTrigger(),
    agent: (roomId, agentId) => agentsRepo().byId(roomId, agentId),
    room: roomState,
    budget: (roomId) => budgetRepo().get(roomId, new Date()),
    open: openThread,
  };
}

let live: FireDeps | undefined;

/** EventBridge Scheduler's target for room schedules. `at` is the occurrence's scheduled time, which Scheduler fills in. */
export const handler = (input: FireInput) => fireSchedule(input, live ??= liveDeps());
