import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { consumeTicket } from "./tickets.js";
import { getConnection, liveRoomIds, saveConnection } from "./connections.js";
import { markConnected, markPing } from "./presence.js";
import { announcePresence, closeConnection, sendToConnection } from "./broadcast.js";
import { handleAction } from "../chat/actions.js";

type Frame = Record<string, unknown>;

const ok = { statusCode: 200 };

/** Every frame of the live socket: connect, disconnect and the client's actions (routed on `action`). */
export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { routeKey, connectionId } = event.requestContext;
  if (routeKey === "$connect") return connect(connectionId, event.queryStringParameters?.ticket);
  if (routeKey === "$disconnect") await closeConnection(connectionId);
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

async function onFrame(connId: string, frame: Frame) {
  const conn = await getConnection(connId);
  if (!conn) return sendToConnection(connId, { type: "ack", requestId: frame.requestId, ok: false, error: "Not connected" });
  if (frame.action !== "ping") return handleAction(connId, conn, frame);
  await markPing(conn.userId);
  return sendToConnection(connId, { type: "pong" });
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
