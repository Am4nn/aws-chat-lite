import { describe, expect, it } from "vitest";
import {
  CreateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand, UpdateScheduleCommand,
  type SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { scheduleTrigger } from "./scheduler.js";

const env = { SCHEDULE_GROUP: "cl-test-agent-schedules", SCHEDULER_ROLE_ARN: "arn:role", SCHEDULE_TARGET_ARN: "arn:fire" };
const notFound = () => Object.assign(new Error("Schedule not found: s1"), { name: "ResourceNotFoundException" });

/** A Scheduler client that records each command and answers with `reply` (throwing what it returns as an Error). */
function recording(reply: (cmd: object) => unknown = () => ({})) {
  const sent: object[] = [];
  const client = {
    send: async (cmd: object) => {
      sent.push(cmd);
      const out = reply(cmd);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as SchedulerClient;
  return { sent, client };
}

const schedule = { scheduleId: "s1", cadence: { kind: "daily", time: "09:00" } as const };

describe("scheduleTrigger", () => {
  it("put updates the schedule in place with the cron, the room's zone, no flexible window and the retry policy", async () => {
    const { sent, client } = recording();
    await scheduleTrigger(client, env).put("r1", schedule, "Asia/Kolkata");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateScheduleCommand);
    expect((sent[0] as UpdateScheduleCommand).input).toEqual({
      Name: "s1", GroupName: "cl-test-agent-schedules",
      ScheduleExpression: "cron(0 9 * * ? *)", ScheduleExpressionTimezone: "Asia/Kolkata",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: "arn:fire", RoleArn: "arn:role",
        Input: JSON.stringify({ roomId: "r1", scheduleId: "s1", at: "<aws.scheduler.scheduled-time>" }),
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
      },
    });
  });

  it("put creates the schedule when there is none to update", async () => {
    const { sent, client } = recording((cmd) => (cmd instanceof UpdateScheduleCommand ? notFound() : {}));
    await scheduleTrigger(client, env).put("r1", schedule, "UTC");
    expect(sent.map((c) => c.constructor)).toEqual([UpdateScheduleCommand, CreateScheduleCommand]);
    expect((sent[1] as CreateScheduleCommand).input).toEqual((sent[0] as UpdateScheduleCommand).input);
  });

  it("put passes other failures on", async () => {
    const { client } = recording(() => new Error("throttled"));
    await expect(scheduleTrigger(client, env).put("r1", schedule, "UTC")).rejects.toThrow("throttled");
  });

  it("remove deletes the schedule, and one that is already gone is fine", async () => {
    const { sent, client } = recording(notFound);
    await scheduleTrigger(client, env).remove("s1");
    expect(sent[0]).toBeInstanceOf(DeleteScheduleCommand);
    expect((sent[0] as DeleteScheduleCommand).input).toEqual({ Name: "s1", GroupName: "cl-test-agent-schedules" });
  });

  it("get returns the schedule, or null when there is none", async () => {
    const found = recording(() => ({ Name: "s1", ScheduleExpression: "cron(0 9 * * ? *)" }));
    expect(await scheduleTrigger(found.client, env).get("s1")).toMatchObject({ ScheduleExpression: "cron(0 9 * * ? *)" });
    expect(found.sent[0]).toBeInstanceOf(GetScheduleCommand);
    expect(await scheduleTrigger(recording(notFound).client, env).get("s1")).toBeNull();
  });

  it("refuses to run without its configuration", async () => {
    await expect(scheduleTrigger(recording().client, {}).remove("s1")).rejects.toThrow("SCHEDULE_GROUP not set");
  });
});
