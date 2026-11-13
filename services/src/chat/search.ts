import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { docClient, queryAll, tableName } from "../lib/db.js";
import { ValidationError } from "../lib/errors.js";
import { requireMember } from "../rooms/membership.js";
import { LAST_SEQ, seqKey, type Message } from "./model.js";
import { toMessage } from "./repo.js";

const MIN_QUERY = 2;
const MAX_RESULTS = 30;
const SCAN_PER_CHAT = 2000;
/** Chats searched at once: a room with hundreds of threads would otherwise fire hundreds of Queries per search. */
const PARALLEL_CHATS = 8;

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

/** The ids of a room's chats or threads (their items' `field`, under sort-key `prefix`). */
const idsUnder = async (roomId: string, prefix: string, field: string) => (await queryAll({
  KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ProjectionExpression: field,
  ExpressionAttributeValues: { ":p": `ROOM#${roomId}`, ":s": prefix },
})).map((i) => String(i[field]));

/**
 * Keyword search across a room's chats and threads (archived threads too: archiving only hides them from the
 * sidebar): the 30 newest matching messages, newest first.
 */
export async function searchMessages(roomId: string, rawQuery: unknown): Promise<{ results: Message[] }> {
  const q = normalizeQuery(rawQuery);
  const ids = (await Promise.all([idsUnder(roomId, "CHAT#", "chatId"), idsUnder(roomId, "THREAD#", "threadId")])).flat();
  const found: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += PARALLEL_CHATS) {
    found.push(...(await Promise.all(ids.slice(i, i + PARALLEL_CHATS).map((id) => matchesIn(id, q)))).flat());
  }
  const newest = found
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_RESULTS);
  return { results: await Promise.all(newest.map(toMessage)) };
}

export async function searchRoom(user: User, roomId: string, rawQuery: unknown): Promise<{ results: Message[] }> {
  normalizeQuery(rawQuery);
  await requireMember(roomId, user.userId);
  return searchMessages(roomId, rawQuery);
}
