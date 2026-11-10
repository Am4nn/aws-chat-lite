import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Target of a one-time EventBridge Scheduler schedule: leaves a mark the spike can find. */
export async function handler() {
  await db.send(new PutCommand({ TableName: process.env.TABLE_NAME!, Item: { pk: "SPIKE#sched", sk: new Date().toISOString() } }));
}
