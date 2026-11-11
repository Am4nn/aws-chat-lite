import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "./db.js";
import { Conflict } from "./errors.js";

/**
 * A fixed-window rate limit: one item per key per window, incremented atomically and swept by TTL. A call past `max`
 * in its window is refused with `message`.
 */
export async function countTowardsRate(key: string, limit: { windowSec: number; max: number; message: string }): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const { Attributes } = await docClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: key, sk: String(Math.floor(nowSec / limit.windowSec)) },
    UpdateExpression: "ADD n :one SET #ttl = :ttl", ExpressionAttributeNames: { "#ttl": "ttl" },
    ExpressionAttributeValues: { ":one": 1, ":ttl": nowSec + 2 * limit.windowSec }, ReturnValues: "UPDATED_NEW",
  }));
  if (Number(Attributes?.n) > limit.max) throw new Conflict(limit.message);
}
