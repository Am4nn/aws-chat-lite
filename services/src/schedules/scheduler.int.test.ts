import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { roomsRepo } from "../rooms/repo.js";
import { scheduleTrigger } from "./scheduler.js";

// Runs against EventBridge Scheduler and DynamoDB on Floci: npm run floci:up && npm run deploy:local, then
// npm -w services run test:int. The trigger is built from the deployed schedules Lambda's own settings.
let trigger: ReturnType<typeof scheduleTrigger>;
let env: Record<string, string | undefined>;
const scheduleId = randomUUID();

beforeAll(async () => {
  const config = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: "cl-local-schedules" }));
  env = config.Environment?.Variables ?? {};
  trigger = scheduleTrigger(new SchedulerClient({}), env);
});

afterAll(() => trigger?.remove(scheduleId));

describe("the schedule trigger on Floci", () => {
  it("put creates the schedule, a second put updates it in place, and remove deletes it", async () => {
    await trigger.put("r1", { scheduleId, cadence: { kind: "daily", time: "09:00" } }, "Asia/Kolkata");
    const created = await trigger.get(scheduleId);
    expect(created).toMatchObject({
      ScheduleExpression: "cron(0 9 * * ? *)", ScheduleExpressionTimezone: "Asia/Kolkata",
      Target: { Arn: env.SCHEDULE_TARGET_ARN, RoleArn: env.SCHEDULER_ROLE_ARN },
    });
    expect(JSON.parse(created!.Target!.Input!)).toMatchObject({ roomId: "r1", scheduleId });

    await trigger.put("r1", { scheduleId, cadence: { kind: "weekdays", time: "18:30" } }, "Europe/London");
    expect(await trigger.get(scheduleId)).toMatchObject({ ScheduleExpression: "cron(30 18 ? * MON-FRI *)", ScheduleExpressionTimezone: "Europe/London" });

    await trigger.remove(scheduleId);
    expect(await trigger.get(scheduleId)).toBeNull();
    await expect(trigger.remove(scheduleId)).resolves.toBeUndefined();
  });
});

describe("the room view on Floci", () => {
  it("has the built-in agent first and the default time zone", async () => {
    const owner = { userId: randomUUID(), username: "owner" };
    const rooms = roomsRepo();
    const { roomId } = await rooms.createRoom(owner, "Zones");
    const view = await rooms.getRoomView(roomId, owner.userId);
    expect(view.agents.map((a) => a.agentId)).toEqual(["agent"]);
    expect(view.timeZone).toBe("Asia/Kolkata");
  });
});
