import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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
