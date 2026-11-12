import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { roomMembers } from "../chat/membership.js";
import { bestEffort } from "../lib/best-effort.js";
import { queryAll } from "../lib/db.js";
import { forgetConnection } from "./connections.js";
import { isOnline, markDisconnected, type Presence } from "./presence.js";

let cached: ApiGatewayManagementApiClient | undefined;

function managementApi() {
  const endpoint = process.env.WS_CALLBACK_URL;
  if (!endpoint) throw new Error("WS_CALLBACK_URL not set");
  return (cached ??= new ApiGatewayManagementApiClient({ endpoint }));
}

/** The `CONN#<connId>` items under one partition: a user's sockets, or a room's subscriptions (which name the owner). */
const connItems = (pk: string) =>
  queryAll({ KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", ExpressionAttributeValues: { ":p": pk, ":c": "CONN#" } });

const connIdOf = (item: Record<string, unknown>) => String(item.sk).slice("CONN#".length);

/**
 * Best effort: the event is already stored when this runs, and a client that misses it catches up by fetching
 * history, so one bad socket never fails the action that caused the event.
 */
export async function sendToConnection(connId: string, event: object): Promise<void> {
  try {
    await managementApi().send(new PostToConnectionCommand({ ConnectionId: connId, Data: JSON.stringify(event) }));
  } catch (e) {
    if ((e as Error).name !== "GoneException") {
      console.error("postToConnection failed", connId, e);
      return;
    }
    // The socket closed without (or before) its $disconnect: clean up after it, as $disconnect would.
    await closeConnection(connId, { gone: true });
  }
}

/** A socket is gone: its items go, and when that was a counted socket, the user's rooms hear their new presence. */
export async function closeConnection(connId: string, opts: { gone?: boolean } = {}): Promise<void> {
  const conn = await forgetConnection(connId, opts);
  const presence = conn && await markDisconnected(conn.userId);
  if (conn && presence) await announcePresence(conn.userId, conn.roomIds, presence);
}

export function announcePresence(userId: string, roomIds: string[], p: Presence, exceptConnId?: string) {
  const event = { type: "presence", userId, online: isOnline(p, Math.floor(Date.now() / 1000)), lastSeen: p.lastSeen };
  return Promise.all(roomIds.map((roomId) => broadcastToRoom(roomId, event, { exceptConnId })));
}

export async function sendToUser(userId: string, event: object, opts: { exceptConnId?: string } = {}): Promise<void> {
  const connIds = (await connItems(`USER#${userId}`)).map(connIdOf);
  await Promise.all(connIds.filter((c) => c !== opts.exceptConnId).map((c) => sendToConnection(c, event)));
}

/** Tells the room's open pages to refetch it after a change to its settings. */
export const roomUpdated = (roomId: string) => broadcastToRoom(roomId, { type: "room.updated", roomId });

/**
 * Tells the room's open pages that one of its lists changed, so they refetch it. Best effort: the change is stored,
 * and a page that misses the event gets the list on its next load.
 */
export const roomChanged = (type: "agents.changed" | "memory.changed" | "schedules.changed", roomId: string) =>
  bestEffort(`${type} broadcast`, () => broadcastToRoom(roomId, { type, roomId }));

/**
 * Subscriptions are written when a socket connects, so they go stale when someone leaves or is removed. Checking
 * them against a consistent read of the members on every send means a removed member stops getting events at once.
 */
export async function broadcastToRoom(roomId: string, event: object, opts: { exceptConnId?: string } = {}): Promise<void> {
  const [subs, members] = await Promise.all([
    connItems(`ROOM#${roomId}`),
    roomMembers(roomId, { fields: ["userId"], consistent: true }),
  ]);
  const memberIds = new Set(members.map((m) => String(m.userId)));
  await Promise.all(subs
    .filter((s) => memberIds.has(String(s.userId)) && connIdOf(s) !== opts.exceptConnId)
    .map((s) => sendToConnection(connIdOf(s), event)));
}
