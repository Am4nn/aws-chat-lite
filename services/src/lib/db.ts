import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand, DeleteCommand, DynamoDBDocumentClient, QueryCommand, TransactWriteCommand,
  type BatchGetCommandInput, type BatchGetCommandOutput, type QueryCommandInput, type QueryCommandOutput, type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { requiredEnv } from "./env.js";
import { Unavailable } from "./errors.js";
import { sleep } from "./sleep.js";

let cached: DynamoDBDocumentClient | undefined;

/** One DocumentClient per Lambda container (reused across warm invocations). */
export function docClient(): DynamoDBDocumentClient {
  cached ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cached;
}

export const tableName = () => requiredEnv("TABLE_NAME");

export type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/** An item without its table keys, as the rest of the app sees it. */
export const withoutKeys = <T = Record<string, unknown>>({ pk: _pk, sk: _sk, ...rest }: Record<string, unknown>) => rest as T;

/** True when a write failed its condition (single write or one item of a transaction). */
export function conditionFailed(e: unknown): boolean {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  return err.name === "ConditionalCheckFailedException"
    || (err.name === "TransactionCanceledException" && !!err.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed"));
}

/** True when a transaction was cancelled because item `index` (in TransactItems order) failed its condition. */
export function failedAt(e: unknown, index: number): boolean {
  return (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.[index]?.Code === "ConditionalCheckFailed";
}

/** True when a transaction was cancelled because another transaction was writing one of its items at the same time. */
export function transactionConflict(e: unknown): boolean {
  return !!(e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.some((r) => r.Code === "TransactionConflict");
}

/**
 * One transaction, tried again when DynamoDB cancels it as a TransactionConflict: another transaction was writing one
 * of its items at the same moment (a room's META counters, say), which is worth another go. Any other failure, a
 * condition included, is the caller's to read.
 */
export async function transactWrite(TransactItems: TransactItem[], attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await docClient().send(new TransactWriteCommand({ TransactItems }));
    } catch (e) {
      if (!transactionConflict(e) || attempt === attempts) throw e;
    }
  }
}

/**
 * Deletes an item as it reads it, so it works once, whoever presents it. TTL deletion can lag by days, hence the
 * expiry check. Throws `expired` when the item is gone or out of date.
 */
export async function takeOnce(Key: Record<string, string>, expired: Error): Promise<Record<string, unknown>> {
  try {
    const { Attributes } = await docClient().send(new DeleteCommand({
      TableName: tableName(), Key, ReturnValues: "ALL_OLD",
      ConditionExpression: "attribute_exists(pk) AND #ttl > :now",
      ExpressionAttributeNames: { "#ttl": "ttl" }, ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) },
    }));
    return Attributes!;
  } catch (e) {
    if (conditionFailed(e)) throw expired;
    throw e;
  }
}

/** Every item a query matches. One Query call returns at most 1 MB, so this follows LastEvaluatedKey to the end. */
export async function queryAll(input: Omit<QueryCommandInput, "TableName" | "ExclusiveStartKey">) {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
  do {
    const page: QueryCommandOutput = await docClient().send(new QueryCommand({ ...input, TableName: tableName(), ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const BATCH_GET_MAX = 100;
const BATCH_GET_ATTEMPTS = 5;

/**
 * Items by key, in no particular order. BatchGet takes at most 100 keys a call and may hand some back unprocessed
 * when the table is busy, so this chunks the keys and retries the leftovers with exponential backoff, as AWS advises,
 * giving up after a few attempts rather than holding the request open on a throttled table.
 */
export async function batchGet(keys: Record<string, string>[], opts: { consistent?: boolean } = {}) {
  const TableName = tableName();
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_MAX) {
    let request: BatchGetCommandInput["RequestItems"] = {
      [TableName]: { Keys: keys.slice(i, i + BATCH_GET_MAX), ConsistentRead: opts.consistent },
    };
    for (let attempt = 0; request && Object.keys(request).length; attempt++) {
      if (attempt === BATCH_GET_ATTEMPTS) throw new Unavailable("The server is busy right now; try again in a moment.");
      if (attempt) await sleep(50 * 2 ** attempt);
      const { Responses, UnprocessedKeys }: BatchGetCommandOutput = await docClient().send(new BatchGetCommand({ RequestItems: request }));
      items.push(...(Responses?.[TableName] ?? []));
      request = UnprocessedKeys;
    }
  }
  return items;
}

/**
 * `SET #f = :f, …` for each defined field. Every attribute name goes through a placeholder: DynamoDB rejects reserved
 * words such as `status` and `steps` written bare in an expression.
 */
export function setFields(fields: Record<string, unknown>) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  return {
    UpdateExpression: `SET ${keys.map((k) => `#${k} = :${k}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(keys.map((k) => [`#${k}`, k])),
    ExpressionAttributeValues: Object.fromEntries(keys.map((k) => [`:${k}`, fields[k]])),
  };
}
