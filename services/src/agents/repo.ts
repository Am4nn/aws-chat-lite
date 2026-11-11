import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { conditionFailed, docClient, failedAt, queryAll, tableName, transactionConflict } from "../lib/db.js";
import { Conflict, Forbidden, NotFound, ValidationError } from "../lib/errors.js";
import { roomKey } from "../lib/keys.js";
import { requireMember } from "../chat/membership.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { uniqueCandidates } from "../threads/model.js";
import type { Agent } from "../threads/types.js";
import { BUILT_IN, MAX_AGENTS, canChange } from "./model.js";

type StoredAgent = Agent & { deleted?: boolean };
type AgentInput = Pick<Agent, "name" | "instructions" | "tools" | "model">;

const agentKey = (roomId: string, agentId: string) => ({ pk: roomKey(roomId), sk: `AGENT#${agentId}` });
const nameKey = (roomId: string, name: string) => ({ pk: roomKey(roomId), sk: `AGENTNAME#${name}` });
const metaKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "META" });
const BUILT_IN_REFUSAL = "The built-in @agent can't be renamed, deleted or copied.";
const taken = (name: string) => new Conflict(`@${name} is taken in this room.`);
const changed = (name: string) => new Conflict(`@${name} just changed; try again.`);

/** The built-in is stored only once an admin edits it, and then only the fields they changed. */
function toAgent({ pk: _pk, sk: _sk, ...item }: Record<string, unknown>): StoredAgent {
  return item.agentId === BUILT_IN.agentId ? { ...BUILT_IN, ...item } : item as StoredAgent;
}

/** `SET #f0 = :f0, …` over the given fields; placeholders throughout, as `name` is a reserved word. */
function setFields(fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  return {
    UpdateExpression: `SET ${keys.map((_, i) => `#f${i} = :f${i}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(keys.map((k, i) => [`#f${i}`, k])),
    ExpressionAttributeValues: Object.fromEntries(keys.map((k, i) => [`:f${i}`, fields[k]])),
  };
}

/** Best effort: the write has happened, and a page that misses the event gets the agents on its next load. */
const announce = (roomId: string) =>
  bestEffort("agents.changed broadcast", () => broadcastToRoom(roomId, { type: "agents.changed", roomId }));

/**
 * The room's agents (single table, in the room partition). An `AGENTNAME#` guard per live name makes names unique per
 * room even for two creates at the same moment, and META counts the agents so the cap holds the same way.
 */
export function agentsRepo() {
  const db = docClient();
  const TableName = tableName();

  async function byId(roomId: string, agentId: string): Promise<StoredAgent | null> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: agentKey(roomId, agentId), ConsistentRead: true }));
    if (Item) return toAgent(Item);
    return agentId === BUILT_IN.agentId ? BUILT_IN : null;
  }

  /** Lowercased, as mentions match names in any case. */
  async function usernames(roomId: string) {
    const members = await queryAll({
      KeyConditionExpression: "pk = :p AND begins_with(sk, :m)", ProjectionExpression: "username",
      ExpressionAttributeValues: { ":p": roomKey(roomId), ":m": "MEMBER#" },
    });
    return new Set(members.map((m) => String(m.username).toLowerCase()));
  }

  /**
   * The member, and the agent they may change. Checked again by the write's own conditions, for an edit or a delete
   * landing after this read.
   */
  async function changeable(user: User, roomId: string, agentId: string) {
    const role = await requireMember(roomId, user.userId, { writing: true });
    const agent = await byId(roomId, agentId);
    if (!agent || agent.deleted) throw new NotFound("No such agent.");
    if (!canChange(agent, { userId: user.userId, role })) throw new Forbidden(`Only its creator or an admin can change @${agent.name}.`);
    return agent;
  }

  /**
   * One transaction: META counts the agent (only below the cap), the name's guard is claimed (only if free) and the
   * agent is written. False when the name is taken. Two writes to META at once can cancel each other on DynamoDB, so
   * a cancelled attempt is tried again.
   */
  async function claim(roomId: string, agent: Agent): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName, Key: metaKey(roomId), UpdateExpression: "ADD agentCount :one",
                ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(agentCount) OR agentCount < :max)",
                ExpressionAttributeValues: { ":one": 1, ":max": MAX_AGENTS },
              },
            },
            { Put: { TableName, Item: { ...nameKey(roomId, agent.name), agentId: agent.agentId }, ConditionExpression: "attribute_not_exists(pk)" } },
            { Put: { TableName, Item: { ...agentKey(roomId, agent.agentId), ...agent } } },
          ],
        }));
        return true;
      } catch (e) {
        if (failedAt(e, 0)) throw new Conflict(`A room has at most ${MAX_AGENTS} agents.`);
        if (failedAt(e, 1)) return false;
        if (transactionConflict(e) && attempt < 3) continue;
        if (transactionConflict(e)) throw new Conflict("The room just changed; try again.");
        throw e;
      }
    }
  }

  return {
    byId,

    /** The built-in first, then the others by name; deleted agents are left out. */
    async list(roomId: string): Promise<Agent[]> {
      const items = await queryAll({
        KeyConditionExpression: "pk = :p AND begins_with(sk, :a)", ConsistentRead: true,
        ExpressionAttributeValues: { ":p": roomKey(roomId), ":a": "AGENT#" },
      });
      const stored = items.map(toAgent);
      const builtIn = stored.find((a) => a.builtIn) ?? BUILT_IN;
      const others = stored.filter((a) => !a.builtIn && !a.deleted).sort((a, b) => a.name.localeCompare(b.name));
      return [builtIn, ...others];
    },

    /**
     * `input` is already validated. A name may not be a member's username, so a mention never means two things the
     * day it is made. With `unique` (a copy), a taken name moves on to name-2 … name-9.
     */
    async create(user: User, roomId: string, input: AgentInput, opts: { unique?: boolean } = {}): Promise<Agent> {
      await requireMember(roomId, user.userId, { writing: true });
      const members = await usernames(roomId);
      if (!opts.unique && members.has(input.name)) throw new Conflict(`@${input.name} is someone's username in this room.`);
      const now = new Date().toISOString();
      const base = { ...input, builtIn: false, createdBy: user.userId, createdByName: user.username, createdAt: now, updatedAt: now };
      const names = opts.unique ? uniqueCandidates(input.name).filter((n) => !members.has(n)) : [input.name];
      for (const name of names) {
        const agent: Agent = { ...base, agentId: randomUUID(), name };
        if (await claim(roomId, agent)) {
          await announce(roomId);
          return agent;
        }
      }
      throw taken(input.name);
    },

    /**
     * `patch` is already validated. A rename moves the guard in the same transaction: the old guard goes (only while it
     * is still this agent's), the new one is claimed (only if free), and the agent changes only if it still has the name
     * we read, so of two renames at once only one wins.
     */
    async update(user: User, roomId: string, agentId: string, patch: Partial<AgentInput>): Promise<Agent> {
      const agent = await changeable(user, roomId, agentId);
      const renaming = patch.name !== undefined && patch.name !== agent.name;
      if (renaming && agent.builtIn) throw new ValidationError(BUILT_IN_REFUSAL);
      if (renaming && (await usernames(roomId)).has(patch.name!)) throw new Conflict(`@${patch.name} is someone's username in this room.`);
      const fields = { ...patch, updatedAt: new Date().toISOString() };
      const set = setFields(fields);
      // The built-in can't be deleted, and its item may not exist yet: the update writes it.
      const write = {
        TableName, Key: agentKey(roomId, agentId), ...set,
        ...(!agent.builtIn && {
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(deleted) AND #name = :old",
          ExpressionAttributeNames: { ...set.ExpressionAttributeNames, "#name": "name" },
          ExpressionAttributeValues: { ...set.ExpressionAttributeValues, ":old": agent.name },
        }),
      };
      try {
        if (!renaming) {
          await db.send(new UpdateCommand(write));
        } else {
          await db.send(new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName, Key: nameKey(roomId, agent.name), ConditionExpression: "agentId = :id",
                  ExpressionAttributeValues: { ":id": agentId },
                },
              },
              { Put: { TableName, Item: { ...nameKey(roomId, patch.name!), agentId }, ConditionExpression: "attribute_not_exists(pk)" } },
              { Update: write },
            ],
          }));
        }
      } catch (e) {
        if (failedAt(e, 1)) throw taken(patch.name!);
        if (conditionFailed(e) || transactionConflict(e)) throw changed(agent.name);
        throw e;
      }
      await announce(roomId);
      return { ...agent, ...fields };
    },

    /** Soft: the item stays for the threads that name it, while the name and the slot under the cap are freed. */
    async remove(user: User, roomId: string, agentId: string): Promise<void> {
      if (agentId === BUILT_IN.agentId) {
        await requireMember(roomId, user.userId, { writing: true });
        throw new ValidationError(BUILT_IN_REFUSAL);
      }
      const agent = await changeable(user, roomId, agentId);
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName, Key: agentKey(roomId, agentId), UpdateExpression: "SET deleted = :t, updatedAt = :now",
                ConditionExpression: "attribute_not_exists(deleted)",
                ExpressionAttributeValues: { ":t": true, ":now": new Date().toISOString() },
              },
            },
            {
              Delete: {
                TableName, Key: nameKey(roomId, agent.name), ConditionExpression: "agentId = :id",
                ExpressionAttributeValues: { ":id": agentId },
              },
            },
            { Update: { TableName, Key: metaKey(roomId), UpdateExpression: "ADD agentCount :minus", ExpressionAttributeValues: { ":minus": -1 } } },
          ],
        }));
      } catch (e) {
        if (failedAt(e, 0)) throw new NotFound("No such agent.");
        if (conditionFailed(e) || transactionConflict(e)) throw changed(agent.name);
        throw e;
      }
      await announce(roomId);
    },
  };
}
