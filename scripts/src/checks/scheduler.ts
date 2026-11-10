import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { check, withTimeout, sleep, type Outputs, type Stage } from "./util.js";

/** Scheduler's one-time format: at(yyyy-mm-ddThh:mm:ss), UTC, no milliseconds. */
const atExpression = (d: Date) => `at(${d.toISOString().slice(0, 19)})`;

export async function run(o: Outputs, _stage: Stage) {
  const scheduler = new SchedulerClient({});
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const Name = `spike-${Date.now()}`;
  return [
    await check("EventBridge Scheduler", "a one-time schedule invokes the Lambda (within ~2 min)", async () => {
      const since = new Date().toISOString();
      const at = new Date(Date.now() + 70_000);
      await scheduler.send(new CreateScheduleCommand({
        Name, GroupName: o.SchedulerGroup, ScheduleExpression: atExpression(at), ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: { Arn: o.ScheduleTargetFnArn, RoleArn: o.SchedulerRoleArn, Input: "{}" },
      }));
      try {
        const firedAt = await withTimeout((async () => {
          for (;;) {
            const { Items = [] } = await db.send(new QueryCommand({
              TableName: o.TableName, KeyConditionExpression: "pk = :p AND sk > :s",
              ExpressionAttributeValues: { ":p": "SPIKE#sched", ":s": since },
            }));
            if (Items.length) return String(Items[0].sk);
            await sleep(5000);
          }
        })(), 150_000, "scheduled invocation");
        const lateMs = Date.parse(firedAt) - at.getTime();
        return `fired ${Math.round(lateMs / 1000)} s after the scheduled time`;
      } finally {
        await scheduler.send(new DeleteScheduleCommand({ Name, GroupName: o.SchedulerGroup })).catch(() => {});
      }
    }),
  ];
}
