import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { budgetText } from "../budget/model.js";
import { budgetRepo } from "../budget/repo.js";
import { requireMember } from "../rooms/membership.js";
import type { User } from "../lib/auth.js";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import { Conflict, NotFound } from "../lib/errors.js";
import { roomKey } from "../lib/keys.js";
import { countTowardsRate } from "../lib/rate.js";
import { transcribeMicros } from "./prices.js";

export const MAX_DICTATION_SEC = 60;
const SESSION_TTL_SEC = 86_400;

const sessionKey = (roomId: string, sessionId: string) => ({ pk: roomKey(roomId), sk: `VOICE#${sessionId}` });

/**
 * Dictation sessions and what they cost. The browser streams straight to Transcribe, so the server never sees how long
 * a dictation ran: a session reserves the longest one up front, and its `done` refunds the part the browser says went
 * unused. A session that never reports stays billed in full.
 */
export function voiceRepo() {
  const db = docClient();
  const TableName = tableName();
  const budgets = budgetRepo();

  return {
    async mint(user: User, roomId: string, sessionId: string): Promise<void> {
      await requireMember(roomId, user.userId, { writing: true });
      await countTowardsRate(`RATE#voice#${user.userId}`, { windowSec: 3600, max: 20, message: "Slow down: 20 dictations an hour." });
      const now = new Date();
      const reserve = transcribeMicros(MAX_DICTATION_SEC);
      const budget = await budgets.get(roomId, now);
      if (budget.spentMicros + reserve > budget.capMicros) throw new Conflict(budgetText(budget.capMicros, budget.month));
      const mintedAt = now.toISOString();
      await db.send(new TransactWriteCommand({
        TransactItems: [
          budgets.spend(roomId, reserve, now),
          {
            Put: {
              TableName, Item: {
                ...sessionKey(roomId, sessionId), userId: user.userId, mintedAt, reservedSec: MAX_DICTATION_SEC,
                ttl: Math.floor(now.getTime() / 1000) + SESSION_TTL_SEC,
              },
            },
          },
        ],
      }));
    },

    /**
     * The browser's word for how long it streamed, believed only within what is possible: at most the reservation and
     * at most the time since the session was minted. The refund lands on the month the reservation was charged to.
     */
    async done(user: User, roomId: string, sessionId: string, seconds: number): Promise<{ billedSeconds: number }> {
      const { Item } = await db.send(new GetCommand({ TableName, Key: sessionKey(roomId, sessionId), ConsistentRead: true }));
      if (Item?.userId !== user.userId) throw new NotFound("No such dictation.");
      const counted = new Conflict("That dictation was already counted.");
      if (Item.doneAt) throw counted;
      const mintedAt = new Date(String(Item.mintedAt));
      const sinceMint = Math.max(0, Math.ceil((Date.now() - mintedAt.getTime()) / 1000));
      const billedSeconds = Math.min(Math.ceil(seconds), Number(Item.reservedSec), sinceMint);
      const refund = transcribeMicros(Number(Item.reservedSec) - billedSeconds);
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            {
              // The condition settles two `done`s racing past the read above: only one of them refunds.
              Update: {
                TableName, Key: sessionKey(roomId, sessionId), UpdateExpression: "SET doneAt = :now, billedSec = :b",
                ConditionExpression: "attribute_not_exists(doneAt) AND userId = :me",
                ExpressionAttributeValues: { ":now": new Date().toISOString(), ":b": billedSeconds, ":me": user.userId },
              },
            },
            ...(refund ? [budgets.spend(roomId, -refund, mintedAt)] : []),
          ],
        }));
      } catch (e) {
        if (conditionFailed(e)) throw counted;
        throw e;
      }
      return { billedSeconds };
    },
  };
}

export type VoiceRepo = ReturnType<typeof voiceRepo>;
