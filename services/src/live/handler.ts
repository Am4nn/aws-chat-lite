import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { consumeTicket } from "./tickets.js";
import { forgetConnection, getConnection, liveRoomIds, saveConnection } from "./connections.js";
import { isOnline, markConnected, markDisconnected, markPing, type Presence } from "./presence.js";
import { broadcastToRoom, sendToConnection } from "./broadcast.js";
import { handleAction } from "../chat/actions.js";

type Frame = Record<string, unknown>;

const ok = { statusCode: 200 };

/** Every frame of the live socket: connect, disconnect and the client's actions (routed on `action`). */
export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { routeKey, connectionId } = event.requestContext;
  if (routeKey === "$connect") return connect(connectionId, event.queryStringParameters?.ticket);
  if (routeKey === "$disconnect") await disconnect(connectionId);
  else await onFrame(connectionId, parseFrame(event.body));
  return ok;
}

async function connect(connId: string, ticket: string | undefined) {
  const user = ticket ? await consumeTicket(ticket) : null;
  if (!user) return { statusCode: 401 };
  const roomIds = await liveRoomIds(user.userId);
  await saveConnection(connId, user, roomIds);
  // A socket can't be posted to until its $connect returns, so the new one is left out of its own announcement.
  await announcePresence(user.userId, roomIds, await markConnected(user.userId), connId);
  return ok;
}

async function disconnect(connId: string) {
  const conn = await forgetConnection(connId);
  if (conn) await announcePresence(conn.userId, conn.roomIds, await markDisconnected(conn.userId));
}

function announcePresence(userId: string, roomIds: string[], p: Presence, exceptConnId?: string) {
  const event = { type: "presence", userId, online: isOnline(p, Math.floor(Date.now() / 1000)), lastSeen: p.lastSeen };
  return Promise.all(roomIds.map((roomId) => broadcastToRoom(roomId, event, { exceptConnId })));
}

async function onFrame(connId: string, frame: Frame) {
  const reply = (r: { ok: true } | { ok: false; error: string }) =>
    sendToConnection(connId, { type: "ack", requestId: frame.requestId, ...r });
  const conn = await getConnection(connId);
  if (!conn) return reply({ ok: false, error: "Not connected" });
  switch (frame.action) {
    case "ping":
      await markPing(conn.userId);
      return sendToConnection(connId, { type: "pong" });
    case "subscribe":
      // Sent after joining a room, so the open socket starts getting its events without reconnecting.
      await saveConnection(connId, conn, await liveRoomIds(conn.userId), conn.roomIds);
      return reply({ ok: true });
    default:
      return handleAction(connId, conn, frame);
  }
}

/** Anything that isn't a JSON object reads as an empty frame, which is acked as an unknown action. */
function parseFrame(body: string | undefined): Frame {
  try {
    const frame = JSON.parse(body ?? "");
    return typeof frame === "object" && frame !== null ? frame : {};
  } catch {
    return {};
  }
}
