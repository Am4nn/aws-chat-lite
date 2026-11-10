import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, type BatchGetCommandInput, type BatchGetCommandOutput } from "@aws-sdk/lib-dynamodb";

let cached: DynamoDBDocumentClient | undefined;

/** One DocumentClient per Lambda container (reused across warm invocations). */
export function docClient(): DynamoDBDocumentClient {
  cached ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cached;
}

export const tableName = () => {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error("TABLE_NAME not set");
  return t;
};

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

const BATCH_GET_MAX = 100;

/**
 * Items by key, in no particular order. BatchGet takes at most 100 keys a call and may hand some back unprocessed
 * when the table is busy, so this chunks the keys and retries the leftovers with exponential backoff, as AWS advises.
 */
export async function batchGet(keys: Record<string, string>[], opts: { consistent?: boolean } = {}) {
  const TableName = tableName();
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_MAX) {
    let request: BatchGetCommandInput["RequestItems"] = {
      [TableName]: { Keys: keys.slice(i, i + BATCH_GET_MAX), ConsistentRead: opts.consistent },
    };
    for (let attempt = 0; request && Object.keys(request).length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const { Responses, UnprocessedKeys }: BatchGetCommandOutput = await docClient().send(new BatchGetCommand({ RequestItems: request }));
      items.push(...(Responses?.[TableName] ?? []));
      request = UnprocessedKeys;
    }
  }
  return items;
}
