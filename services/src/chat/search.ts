import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, queryAll, tableName } from "../lib/db.js";
import { ValidationError } from "../lib/errors.js";
import { requireMember } from "./membership.js";
import { LAST_SEQ, seqKey, type Message } from "./model.js";
import { toMessage } from "./repo.js";

const MIN_QUERY = 2;
const MAX_RESULTS = 30;
const SCAN_PER_CHAT = 2000;

interface User { userId: string; username: string }

/** Lowercased, because messages store `textLower` for this match and DynamoDB's `contains` is case-sensitive. */
export function normalizeQuery(raw: unknown): string {
  const q = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (q.length < MIN_QUERY) throw new ValidationError(`Search needs at least ${MIN_QUERY} characters.`);
  return q;
}

/**
 * Newest matches in one chat. The filter runs after the read, so DynamoDB still reads (and bills) every message it
 * looks at; the cap on items read bounds that cost, which is why search covers only each chat's latest messages.
 */
async function matchesIn(chatId: string, q: string) {
  const found: Record<string, unknown>[] = [];
  let read = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient().send(new QueryCommand({
      TableName: tableName(), KeyConditionExpression: "pk = :p AND sk BETWEEN :first AND :last",
      FilterExpression: "contains(textLower, :q) AND attribute_not_exists(deleted)",
      ExpressionAttributeValues: { ":p": `CHAT#${chatId}`, ":first": seqKey(0), ":last": seqKey(LAST_SEQ), ":q": q },
      ScanIndexForward: false, Limit: SCAN_PER_CHAT - read, ExclusiveStartKey,
    }));
    found.push(...(page.Items ?? []));
    read += page.ScannedCount ?? 0;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && read < SCAN_PER_CHAT && found.length < MAX_RESULTS);
  return found;
}

/** Keyword search across a room's chats: the 30 newest matching messages, newest first. */
export async function searchRoom(user: User, roomId: string, rawQuery: unknown): Promise<{ results: Message[] }> {
  const q = normalizeQuery(rawQuery);
  await requireMember(roomId, user.userId);
  const chats = await queryAll({
    KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", ProjectionExpression: "chatId",
    ExpressionAttributeValues: { ":p": `ROOM#${roomId}`, ":c": "CHAT#" },
  });
  const perChat = await Promise.all(chats.map((c) => matchesIn(String(c.chatId), q)));
  const newest = perChat.flat()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_RESULTS);
  return { results: await Promise.all(newest.map(toMessage)) };
}
