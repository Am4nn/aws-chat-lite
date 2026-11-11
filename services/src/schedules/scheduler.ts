import {
  CreateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand, SchedulerClient, UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from "@aws-sdk/client-scheduler";
import type { Schedule } from "../threads/types.js";
import { cronOf } from "./cadence.js";

const notFound = (e: unknown) => (e as { name?: string }).name === "ResourceNotFoundException";

/**
 * The EventBridge Scheduler schedule that fires one room schedule. It exists only while the schedule is enabled; the
 * schedule item stays the truth, and the fire handler re-checks it.
 */
export function scheduleTrigger(client = new SchedulerClient({}), env: Record<string, string | undefined> = process.env) {
  const setting = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} not set`);
    return value;
  };

  return {
    /**
     * Scheduler has no upsert, so an update is tried first (the usual case: an edit, or the zone changing) and a create
     * follows when there is nothing to update. Scheduler substitutes the occurrence's time into the input, which lets
     * the fire handler claim each occurrence once even when a retry delivers it again.
     */
    async put(roomId: string, schedule: Pick<Schedule, "scheduleId" | "cadence">, tz: string) {
      const input: CreateScheduleCommandInput = {
        Name: schedule.scheduleId, GroupName: setting("SCHEDULE_GROUP"),
        ScheduleExpression: cronOf(schedule.cadence), ScheduleExpressionTimezone: tz,
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: setting("SCHEDULE_TARGET_ARN"), RoleArn: setting("SCHEDULER_ROLE_ARN"),
          Input: JSON.stringify({ roomId, scheduleId: schedule.scheduleId, at: "<aws.scheduler.scheduled-time>" }),
          // A fire more than an hour late would open a thread for a slot that has already passed.
          RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
        },
      };
      try {
        await client.send(new UpdateScheduleCommand(input));
      } catch (e) {
        if (!notFound(e)) throw e;
        await client.send(new CreateScheduleCommand(input));
      }
    },

    async remove(scheduleId: string) {
      try {
        await client.send(new DeleteScheduleCommand({ Name: scheduleId, GroupName: setting("SCHEDULE_GROUP") }));
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },

    async get(scheduleId: string) {
      try {
        return await client.send(new GetScheduleCommand({ Name: scheduleId, GroupName: setting("SCHEDULE_GROUP") }));
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
  };
}
