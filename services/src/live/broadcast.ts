import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { docClient, tableName } from "../lib/db.js";
import { forgetConnection } from "./connections.js";
import { markDisconnected } from "./presence.js";

let cached: ApiGatewayManagementApiClient | undefined;

function managementApi() {
  const endpoint = process.env.WS_CALLBACK_URL;
  if (!endpoint) throw new Error("WS_CALLBACK_URL not set");
  return (cached ??= new ApiGatewayManagementApiClient({ endpoint }));
}

/** The sockets listed under one partition (`CONN#<connId>` items), with the owner a room subscription records. */
async function connIdsUnder(pk: string) {
  const { Items = [] } = await docClient().send(new QueryCommand({
    TableName: tableName(), KeyConditionExpression: "pk = :p AND begins_with(sk, :c)",
    ExpressionAttributeValues: { ":p": pk, ":c": "CONN#" },
  }));
  return Items.map((i) => ({ connId: String(i.sk).slice("CONN#".length), userId: String(i.userId) }));
}

/**
 * Best effort: the event is already stored when this runs, and a client that misses it catches up by fetching
 * history after it reconnects, so one bad socket never fails the action that caused the event.
 */
export async function sendToConnection(connId: string, event: object): Promise<void> {
  try {
    await managementApi().send(new PostToConnectionCommand({ ConnectionId: connId, Data: JSON.stringify(event) }));
  } catch (e) {
    if ((e as Error).name !== "GoneException") {
      console.error("postToConnection failed", connId, e);
      return;
    }
    // The socket closed without (or before) its $disconnect: clean up after it.
    const gone = await forgetConnection(connId);
    if (gone) await markDisconnected(gone.userId);
  }
}

export async function sendToUser(userId: string, event: object, opts: { exceptConnId?: string } = {}): Promise<void> {
  const conns = await connIdsUnder(`USER#${userId}`);
  await Promise.all(conns.filter((c) => c.connId !== opts.exceptConnId).map((c) => sendToConnection(c.connId, event)));
}

/**
 * Subscriptions are written when a socket connects, so they go stale when someone leaves or is removed. Checking
 * them against a consistent read of the members on every send means a removed member stops getting events at once.
 */
export async function broadcastToRoom(roomId: string, event: object, opts: { exceptConnId?: string } = {}): Promise<void> {
  const [subs, members] = await Promise.all([
    connIdsUnder(`ROOM#${roomId}`),
    docClient().send(new QueryCommand({
      TableName: tableName(), KeyConditionExpression: "pk = :p AND begins_with(sk, :m)", ConsistentRead: true,
      ExpressionAttributeValues: { ":p": `ROOM#${roomId}`, ":m": "MEMBER#" }, ProjectionExpression: "userId",
    })),
  ]);
  const memberIds = new Set((members.Items ?? []).map((m) => String(m.userId)));
  await Promise.all(subs
    .filter((s) => memberIds.has(s.userId) && s.connId !== opts.exceptConnId)
    .map((s) => sendToConnection(s.connId, event)));
}
