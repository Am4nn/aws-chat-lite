import { randomUUID } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { requireMember } from "../chat/membership.js";
import type { User } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { conditionFailed, docClient, failedAt, queryAll, tableName, transactionConflict } from "../lib/db.js";
import { NotFound, ValidationError } from "../lib/errors.js";
import { roomKey } from "../lib/keys.js";
import { broadcastToRoom } from "../live/broadcast.js";
import type { MemoryEntry } from "../threads/types.js";
import { MEMORY_MAX, memoryText } from "./model.js";

type AgentSource = Extract<MemoryEntry["source"], { kind: "agent" }>;

const PREFIX = "MEMORY#";
const memoryKey = (roomId: string, memoryId: string) => ({ pk: roomKey(roomId), sk: `${PREFIX}${memoryId}` });
const metaKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "META" });
const withoutKeys = ({ pk: _pk, sk: _sk, ...rest }: Record<string, unknown>) => rest as MemoryEntry;
const missing = (memoryId: string) => new NotFound(`No memory [${memoryId}].`);
const ATTEMPTS = 3;

/**
 * A room's memory: short notes its agents save and its members edit or delete, shown to every run in the room. The
 * room META counts the entries, and each save or delete changes the count in the same transaction, so two saves racing
 * for the last slot can't both land.
 */
export function memoryRepo() {
  const db = docClient();
  const TableName = tableName();

  /** Every open page's Memory panel refetches; the write has already happened, so a failed send only gets logged. */
  const changed = (roomId: string) =>
    bestEffort("memory.changed broadcast", () => broadcastToRoom(roomId, { type: "memory.changed", roomId }));

  /** Newest first. Ids are random, so the sort key carries no order and the sort happens here (at most 50 entries). */
  async function entries(roomId: string): Promise<MemoryEntry[]> {
    const items = await queryAll({
      KeyConditionExpression: "pk = :p AND begins_with(sk, :m)", ConsistentRead: true,
      ExpressionAttributeValues: { ":p": roomKey(roomId), ":m": PREFIX },
    });
    return items.map(withoutKeys).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * `private` only ever turns on: an entry rewritten from a thread with private content may now hold some, while a
   * clean rewrite can't take back what the old text said.
   */
  async function update(roomId: string, memoryId: string, change: { text: unknown; by: string; private?: boolean }): Promise<MemoryEntry> {
    const text = memoryText(change.text);
    try {
      const { Attributes } = await db.send(new UpdateCommand({
        TableName, Key: memoryKey(roomId, memoryId), ConditionExpression: "attribute_exists(pk)", ReturnValues: "ALL_NEW",
        UpdateExpression: `SET #text = :text, updatedAt = :at, updatedBy = :by${change.private ? ", #private = :true" : ""}`,
        ExpressionAttributeNames: { "#text": "text", ...(change.private && { "#private": "private" }) },
        ExpressionAttributeValues: {
          ":text": text, ":at": new Date().toISOString(), ":by": change.by, ...(change.private && { ":true": true }),
        },
      }));
      await changed(roomId);
      return withoutKeys(Attributes!);
    } catch (e) {
      if (conditionFailed(e)) throw missing(memoryId);
      throw e;
    }
  }

  async function forget(roomId: string, memoryId: string): Promise<void> {
    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName, Key: memoryKey(roomId, memoryId), ConditionExpression: "attribute_exists(pk)" } },
          { Update: { TableName, Key: metaKey(roomId), UpdateExpression: "ADD memoryCount :minus", ExpressionAttributeValues: { ":minus": -1 } } },
        ],
      }));
    } catch (e) {
      if (failedAt(e, 0)) throw missing(memoryId);
      throw e;
    }
    await changed(roomId);
  }

  return {
    entries,
    update,
    forget,

    /**
     * Called by the agent's tool, which runs for a member's thread, so it checks no one's role. A new id that clashes
     * with an existing one, or a transaction that lost a race for the META item, tries again.
     */
    async save(roomId: string, input: { text: unknown; private: boolean; source: AgentSource }): Promise<MemoryEntry> {
      const text = memoryText(input.text);
      for (let attempt = 1; ; attempt++) {
        const now = new Date().toISOString();
        const entry: MemoryEntry = {
          memoryId: randomUUID().slice(0, 8), text, private: input.private, source: input.source,
          createdAt: now, updatedAt: now, updatedBy: input.source.agent,
        };
        try {
          await db.send(new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName, Item: { ...memoryKey(roomId, entry.memoryId), ...entry }, ConditionExpression: "attribute_not_exists(pk)" } },
              {
                Update: {
                  TableName, Key: metaKey(roomId), UpdateExpression: "ADD memoryCount :one",
                  ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(memoryCount) OR memoryCount < :max)",
                  ExpressionAttributeValues: { ":one": 1, ":max": MEMORY_MAX },
                },
              },
            ],
          }));
          await changed(roomId);
          return entry;
        } catch (e) {
          if (failedAt(e, 1)) throw new ValidationError("Room memory is full (50 entries). Forget or update one first.");
          if ((failedAt(e, 0) || transactionConflict(e)) && attempt < ATTEMPTS) continue;
          throw e;
        }
      }
    },

    async list(user: User, roomId: string): Promise<MemoryEntry[]> {
      await requireMember(roomId, user.userId);
      return entries(roomId);
    },

    /** Any member may edit any entry. */
    async edit(user: User, roomId: string, memoryId: string, text: unknown): Promise<MemoryEntry> {
      await requireMember(roomId, user.userId, { writing: true });
      return update(roomId, memoryId, { text, by: user.username });
    },

    async remove(user: User, roomId: string, memoryId: string): Promise<void> {
      await requireMember(roomId, user.userId, { writing: true });
      await forget(roomId, memoryId);
    },
  };
}

export type MemoryRepo = ReturnType<typeof memoryRepo>;
