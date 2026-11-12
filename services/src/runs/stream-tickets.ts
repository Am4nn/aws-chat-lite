import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";
import { requireMember } from "../rooms/membership.js";
import { newTicket } from "../live/tickets.js";
import { runsRepo } from "./repo.js";

/**
 * The browser opens a run's stream straight from the stream function, which sees no JWT, so it presents a one-time
 * ticket in the URL instead. A ticket is bound to one run and lasts 60 s: one is fetched for every (re)connect.
 */
const TICKET_TTL_SEC = 60;

const ticketKey = (ticket: string) => ({ pk: `STREAMTICKET#${ticket}`, sk: "META" });

/** A ticket for a member of the run's room; anyone else gets NotFound, as if the run didn't exist. */
export async function issueStreamTicket(user: User, runId: string): Promise<{ ticket: string }> {
  const run = await runsRepo().getRun(runId);
  if (!run) throw new NotFound("Run not found.");
  await requireMember(run.roomId, user.userId);
  const ticket = newTicket();
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
  await docClient().send(new PutCommand({
    TableName: tableName(),
    Item: { ...ticketKey(ticket), userId: user.userId, roomId: run.roomId, runId, expiresAt, ttl: expiresAt },
  }));
  return { ticket };
}

/**
 * The conditional delete makes use-once atomic, and the condition also refuses a ticket issued for another run (that
 * ticket stays usable for its own run). The TTL sweep can lag by hours, so expiry is checked here.
 */
export async function consumeStreamTicket(ticket: string, runId: string): Promise<{ userId: string; roomId: string } | null> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(ticket)) return null;
  try {
    const { Attributes } = await docClient().send(new DeleteCommand({
      TableName: tableName(), Key: ticketKey(ticket), ReturnValues: "ALL_OLD",
      ConditionExpression: "expiresAt > :now AND runId = :runId",
      ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000), ":runId": runId },
    }));
    return { userId: String(Attributes!.userId), roomId: String(Attributes!.roomId) };
  } catch (e) {
    if (conditionFailed(e)) return null;
    throw e;
  }
}
