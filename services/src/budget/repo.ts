import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { Forbidden } from "../lib/errors.js";
import { requireMember } from "../chat/membership.js";
import { can } from "../rooms/access.js";
import type { Budget } from "../threads/types.js";
import { DEFAULT_CAP_MICROS, monthKey, resetsAt } from "./model.js";

interface User { userId: string; username: string }

const metaKey = (roomId: string) => ({ pk: `ROOM#${roomId}`, sk: "META" });
const usageKey = (roomId: string, month: string) => ({ pk: `ROOM#${roomId}`, sk: `USAGE#${month}` });

/** The room's budget for `month`, from its META item (the cap) and its usage item for that month (the spend). */
export function budgetOf(month: string, meta?: Record<string, unknown>, usage?: Record<string, unknown>): Budget {
  return {
    spentMicros: Number(usage?.costMicros ?? 0), capMicros: Number(meta?.budgetCapMicros ?? DEFAULT_CAP_MICROS), month,
    resetsAt: resetsAt(month),
  };
}

/**
 * Each room's monthly agent spend. Usage is one item per room per UTC month, so a new month starts from zero with
 * nothing to reset.
 */
export function budgetRepo() {
  const db = docClient();
  const TableName = tableName();

  /** Consistent, because the run loop checks it before every model call and must see the calls just recorded. */
  const meta = async (roomId: string) =>
    (await db.send(new GetCommand({ TableName, Key: metaKey(roomId), ConsistentRead: true }))).Item;

  async function get(roomId: string, now: Date): Promise<Budget> {
    const month = monthKey(now);
    const [room, { Item: usage }] = await Promise.all([
      meta(roomId),
      db.send(new GetCommand({ TableName, Key: usageKey(roomId, month), ConsistentRead: true })),
    ]);
    return budgetOf(month, room, usage);
  }

  return {
    get,

    /** ADD is atomic, so model calls finishing at once in different runs all count. */
    async record(roomId: string, costMicros: number, now: Date): Promise<Budget> {
      const month = monthKey(now);
      const [room, { Attributes: usage }] = await Promise.all([
        meta(roomId),
        db.send(new UpdateCommand({
          TableName, Key: usageKey(roomId, month), UpdateExpression: "ADD costMicros :c, #calls :one",
          ExpressionAttributeNames: { "#calls": "calls" }, ExpressionAttributeValues: { ":c": costMicros, ":one": 1 },
          ReturnValues: "ALL_NEW",
        })),
      ]);
      return budgetOf(month, room, usage);
    },

    async setCap(user: User, roomId: string, capMicros: number): Promise<Budget> {
      const role = await requireMember(roomId, user.userId, { writing: true });
      if (!can("setBudget", role)) throw new Forbidden("Only the room's owner sets its budget.");
      await db.send(new UpdateCommand({
        TableName, Key: metaKey(roomId), UpdateExpression: "SET budgetCapMicros = :cap", ExpressionAttributeValues: { ":cap": capMicros },
      }));
      return get(roomId, new Date());
    },
  };
}

export type BudgetRepo = ReturnType<typeof budgetRepo>;
