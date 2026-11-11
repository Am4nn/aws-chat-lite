import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { conditionFailed, docClient, tableName } from "../lib/db.js";

/** `roomIds` is a string set, so `subscribe` can add to it atomically; DynamoDB stores no empty set, so it may be absent. */
type Connection = User & { roomIds?: Set<string> };

/** API Gateway closes every socket after 2 hours, so anything older is debris from a missed $disconnect. */
const CONN_TTL_SEC = 3 * 3600;
const expiry = () => Math.floor(Date.now() / 1000) + CONN_TTL_SEC;

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
 * Writes a new socket's items: who it belongs to, its entry under the user (for presence and per-user sends), and one
 * subscription per room (for room fan-out).
 */
export async function saveConnection(connId: string, user: User, roomIds: string[]) {
  const db = docClient();
  const TableName = tableName();
  const ttl = expiry();
  const { userId, username } = user;
  await Promise.all([
    db.send(new PutCommand({ TableName, Item: { ...connKey(connId), userId, username, ttl, ...(roomIds.length > 0 && { roomIds: new Set(roomIds) }) } })),
    db.send(new PutCommand({ TableName, Item: { ...userConnKey(userId, connId), ttl } })),
    ...roomIds.map((roomId) => db.send(new PutCommand({ TableName, Item: { ...roomConnKey(roomId, connId), userId, ttl } }))),
  ]);
}

/**
 * Adds one room to an open socket. The connection item is updated first, and only while it still exists: a subscribe
 * that lands after $disconnect (or a Gone cleanup) deleted it must not bring it back, or the next cleanup would count
 * the socket off presence a second time. If $disconnect lands between the two writes, the subscription it misses
 * expires with its TTL; a post to it meanwhile answers Gone, finds no connection and changes nothing.
 */
export async function subscribe(connId: string, userId: string, roomId: string): Promise<void> {
  const db = docClient();
  const TableName = tableName();
  try {
    await db.send(new UpdateCommand({
      TableName, Key: connKey(connId), UpdateExpression: "ADD roomIds :r", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":r": new Set([roomId]) },
    }));
  } catch (e) {
    if (conditionFailed(e)) return;
    throw e;
  }
  await db.send(new PutCommand({ TableName, Item: { ...roomConnKey(roomId, connId), userId, ttl: expiry() } }));
}

/**
 * Deletes the socket's items. Both $disconnect and a failed post (Gone) can get here for the same socket; only the
 * caller whose delete removed the connection item gets it back, so whatever follows (the presence count) runs once.
 */
export async function forgetConnection(connId: string): Promise<{ userId: string; roomIds: string[] } | undefined> {
  const db = docClient();
  const TableName = tableName();
  const { Attributes } = await db.send(new DeleteCommand({ TableName, Key: connKey(connId), ReturnValues: "ALL_OLD" }));
  if (!Attributes) return undefined;
  const { userId, roomIds } = Attributes as Connection;
  const rooms = [...(roomIds ?? [])];
  await Promise.all([
    db.send(new DeleteCommand({ TableName, Key: userConnKey(userId, connId) })),
    ...rooms.map((roomId) => db.send(new DeleteCommand({ TableName, Key: roomConnKey(roomId, connId) }))),
  ]);
  return { userId, roomIds: rooms };
}
