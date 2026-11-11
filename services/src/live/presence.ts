import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { conditionFailed, docClient, tableName } from "../lib/db.js";

/**
 * Clients ping every 4 minutes. A socket that dies without $disconnect leaves `conns` too high forever, so online
 * also needs a recent ping; 11 minutes allows two missed pings.
 */
const ONLINE_WINDOW_SEC = 11 * 60;

/** Every write sets lastSeen; a user who only ever pinged has no `conns` yet. */
export interface Presence { conns?: number; lastPing?: number; lastSeen: string }

export function isOnline(p: { conns?: number; lastPing?: number } | undefined, nowSec: number): boolean {
  return !!p && (p.conns ?? 0) > 0 && (p.lastPing ?? 0) > nowSec - ONLINE_WINDOW_SEC;
}

/** `conns` is an atomic counter, so a user's tabs connecting and closing at once never lose an update. */
async function update(userId: string, UpdateExpression: string, ExpressionAttributeValues: Record<string, unknown>, ConditionExpression?: string) {
  const { Attributes } = await docClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: `USER#${userId}`, sk: "PRESENCE" },
    UpdateExpression, ExpressionAttributeValues, ConditionExpression, ReturnValues: "ALL_NEW",
  }));
  return Attributes as Presence;
}

// lastSeen moves on every sign of life, so a user whose socket died silently shows when they were last really there.
const seen = () => ({ ":now": Math.floor(Date.now() / 1000), ":iso": new Date().toISOString() });

export const markConnected = (userId: string) =>
  update(userId, "ADD conns :one SET lastPing = :now, lastSeen = :iso", { ":one": 1, ...seen() });

/**
 * A count below zero would hide the user's next open tab, so the decrement only applies while some socket is counted.
 * Undefined means it didn't apply: the user was already counted offline, so there is nothing to announce.
 */
export async function markDisconnected(userId: string): Promise<Presence | undefined> {
  try {
    return await update(userId, "ADD conns :minusOne SET lastSeen = :iso", { ":minusOne": -1, ":zero": 0, ":iso": seen()[":iso"] }, "conns > :zero");
  } catch (e) {
    if (conditionFailed(e)) return undefined;
    throw e;
  }
}

export const markPing = (userId: string) => update(userId, "SET lastPing = :now, lastSeen = :iso", seen());
