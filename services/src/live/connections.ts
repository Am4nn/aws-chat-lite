import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";

interface Connection { userId: string; username: string; roomIds: string[] }

/** API Gateway closes every socket after 2 hours, so anything older is debris from a missed $disconnect. */
const CONN_TTL_SEC = 3 * 3600;

const connKey = (connId: string) => ({ pk: `CONN#${connId}`, sk: "META" });
const userConnKey = (userId: string, connId: string) => ({ pk: `USER#${userId}`, sk: `CONN#${connId}` });
const roomConnKey = (roomId: string, connId: string) => ({ pk: `ROOM#${roomId}`, sk: `CONN#${connId}` });

/** The rooms whose events this user should get: their memberships, from gsi1, minus archived rooms. */
export async function liveRoomIds(userId: string): Promise<string[]> {
  const { Items = [] } = await docClient().send(new QueryCommand({
    TableName: tableName(), IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :u",
    ExpressionAttributeValues: { ":u": `USER#${userId}` },
  }));
  return Items.filter((i) => !i.archived).map((i) => String(i.roomId));
}

export async function getConnection(connId: string): Promise<Connection | undefined> {
  const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: connKey(connId) }));
  return Item as Connection | undefined;
}

/**
 * Writes the socket's items: who it belongs to, its entry under the user (for presence and per-user sends), and one
 * subscription per room (for room fan-out). Rooms in `previous` but not in `roomIds` lose their subscription.
 */
export async function saveConnection(connId: string, user: Omit<Connection, "roomIds">, roomIds: string[], previous: string[] = []) {
  const db = docClient();
  const TableName = tableName();
  const ttl = Math.floor(Date.now() / 1000) + CONN_TTL_SEC;
  const { userId, username } = user;
  await Promise.all([
    db.send(new PutCommand({ TableName, Item: { ...connKey(connId), userId, username, roomIds, ttl } })),
    db.send(new PutCommand({ TableName, Item: { ...userConnKey(userId, connId), ttl } })),
    ...roomIds.map((roomId) => db.send(new PutCommand({ TableName, Item: { ...roomConnKey(roomId, connId), userId, ttl } }))),
    ...previous.filter((r) => !roomIds.includes(r)).map((roomId) => db.send(new DeleteCommand({ TableName, Key: roomConnKey(roomId, connId) }))),
  ]);
}

/**
 * Deletes the socket's items. Both $disconnect and a failed post (Gone) can get here for the same socket; only the
 * caller whose delete removed the connection item gets it back, so whatever follows (the presence count) runs once.
 */
export async function forgetConnection(connId: string): Promise<Connection | undefined> {
  const db = docClient();
  const TableName = tableName();
  const { Attributes } = await db.send(new DeleteCommand({ TableName, Key: connKey(connId), ReturnValues: "ALL_OLD" }));
  if (!Attributes) return undefined;
  const conn = Attributes as Connection;
  await Promise.all([
    db.send(new DeleteCommand({ TableName, Key: userConnKey(conn.userId, connId) })),
    ...conn.roomIds.map((roomId) => db.send(new DeleteCommand({ TableName, Key: roomConnKey(roomId, connId) }))),
  ]);
  return conn;
}
