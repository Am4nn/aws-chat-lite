import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";

/** Target of a one-time EventBridge Scheduler schedule: leaves a mark the spike can find. */
export async function handler() {
  await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: "SPIKE#sched", sk: new Date().toISOString() } }));
}
