import { randomBytes } from "node:crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { conditionFailed, docClient, tableName } from "../lib/db.js";

/**
 * Browsers can't set headers on a WebSocket upgrade, so the socket proves who it is with a one-time ticket in the
 * URL, issued over the JWT-protected HTTP API. Short-lived and single-use, so a ticket leaked from a URL log is
 * worthless.
 */
const TICKET_TTL_SEC = 60;

const ticketKey = (ticket: string) => ({ pk: `WSTICKET#${ticket}`, sk: "META" });

export const newTicket = () => randomBytes(16).toString("base64url");

export async function issueTicket(user: User): Promise<{ ticket: string }> {
  const ticket = newTicket();
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
  await docClient().send(new PutCommand({
    TableName: tableName(),
    Item: { ...ticketKey(ticket), userId: user.userId, username: user.username, expiresAt, ttl: expiresAt },
  }));
  return { ticket };
}

/**
 * Deleting with a condition makes use-once atomic: of two sockets presenting the same ticket, only one delete
 * matches. The TTL sweep can lag by hours, so the expiry is checked here, not left to it.
 */
export async function consumeTicket(ticket: string): Promise<User | null> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(ticket)) return null;
  try {
    const { Attributes } = await docClient().send(new DeleteCommand({
      TableName: tableName(), Key: ticketKey(ticket), ReturnValues: "ALL_OLD",
      ConditionExpression: "expiresAt > :now", ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) },
    }));
    return { userId: String(Attributes!.userId), username: String(Attributes!.username) };
  } catch (e) {
    if (conditionFailed(e)) return null;
    throw e;
  }
}
