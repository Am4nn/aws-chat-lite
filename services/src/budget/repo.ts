import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { docClient, tableName } from "../lib/db.js";
import { Forbidden } from "../lib/errors.js";
import { requireMember } from "../chat/membership.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { can } from "../rooms/access.js";
import type { TransactItem } from "../runs/repo.js";
import type { Budget } from "../threads/types.js";
import { budgetOf, monthKey } from "./model.js";
import { roomKey, roomMetaKey } from "../lib/keys.js";

const usageKey = (roomId: string, month: string) => ({ pk: roomKey(roomId), sk: `USAGE#${month}` });

/**
 * Each room's monthly agent spend. Usage is one item per room per UTC month, so a new month starts from zero with
 * nothing to reset.
 */
export function budgetRepo() {
  const db = docClient();
  const TableName = tableName();

  /** Consistent, because the run loop checks it before every model call and must see the calls just recorded. */
  const meta = async (roomId: string) =>
    (await db.send(new GetCommand({ TableName, Key: roomMetaKey(roomId), ConsistentRead: true }))).Item;

  /** The budget, and from the same read of the room, whether it was archived, which also ends its runs. */
  async function withArchived(roomId: string, now: Date): Promise<{ budget: Budget; archived: boolean }> {
    const month = monthKey(now);
    const [room, { Item: usage }] = await Promise.all([
      meta(roomId),
      db.send(new GetCommand({ TableName, Key: usageKey(roomId, month), ConsistentRead: true })),
    ]);
    return { budget: budgetOf(month, room, usage), archived: !!room?.archived };
  }

  const get = async (roomId: string, now: Date): Promise<Budget> => (await withArchived(roomId, now)).budget;

  return {
    get,
    withArchived,

    /**
     * A model call's cost, as a write for the transaction that records the call. ADD is atomic, so calls finishing
     * at once in different runs all count.
     */
    spend(roomId: string, costMicros: number, now: Date): TransactItem {
      return {
        Update: {
          TableName, Key: usageKey(roomId, monthKey(now)), UpdateExpression: "ADD costMicros :c",
          ExpressionAttributeValues: { ":c": costMicros },
        },
      };
    },

    /** The room hears the new cap at once, so every member's budget card shows it without a reload. */
    async setCap(user: User, roomId: string, capMicros: number): Promise<Budget> {
      const role = await requireMember(roomId, user.userId, { writing: true });
      if (!can("setBudget", role)) throw new Forbidden("Only the room's owner sets its budget.");
      await db.send(new UpdateCommand({
        TableName, Key: roomMetaKey(roomId), UpdateExpression: "SET budgetCapMicros = :cap", ExpressionAttributeValues: { ":cap": capMicros },
      }));
      const budget = await get(roomId, new Date());
      await bestEffort("budget.updated broadcast", () => broadcastToRoom(roomId, { type: "budget.updated", roomId, budget }));
      return budget;
    },
  };
}

export type BudgetRepo = ReturnType<typeof budgetRepo>;
