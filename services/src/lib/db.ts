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
