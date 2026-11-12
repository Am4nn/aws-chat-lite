import { ArnFormat, CfnOutput, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { CoreStack } from "./core-stack.js";

/**
 * Room schedules on EventBridge Scheduler: a schedule group holding one schedule per enabled room schedule, the fire
 * Lambda they invoke, the role Scheduler invokes it with, and the schedules and time zone routes. Each room schedule's
 * item is the truth, and the fire Lambda re-checks it, so the Scheduler side holds no state worth protecting.
 */
export function addSchedules(stack: CoreStack) {
  const group = new scheduler.CfnScheduleGroup(stack, "AgentSchedules", { name: `${stack.stageConfig.prefix}-agent-schedules` });
  const groupName = group.name!;

  const fireFn = stack.addFunction("schedule-fire", "schedules/fire.ts", { tableAccess: true, timeout: Duration.seconds(30) });
  // A stale schedule (its item gone or off, its agent deleted, its room archived) deletes itself when it fires.
  allowSchedules(stack, fireFn, groupName, ["DeleteSchedule"]);
  stack.allowBroadcast(fireFn);
  stack.allowRunStart(fireFn);
  // A card or prompt can mention members, who get a push.
  stack.allowPush(fireFn);

  // The SourceAccount condition stops another account's schedule from using this role (the confused deputy).
  const role = new iam.Role(stack, "SchedulerRole", {
    assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": stack.account } } }),
  });
  // Schedules target the function itself, never a version or alias.
  role.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [fireFn.functionArn] }));

  const fn = stack.addFunction("schedules", "schedules/handler.ts", {
    tableAccess: true,
    timeout: Duration.seconds(15),
    environment: { SCHEDULER_ROLE_ARN: role.roleArn, SCHEDULE_TARGET_ARN: fireFn.functionArn },
  });
  allowSchedules(stack, fn, groupName, ["CreateSchedule", "UpdateSchedule", "DeleteSchedule", "GetSchedule"]);
  role.grantPassRole(fn.grantPrincipal);
  stack.allowBroadcast(fn);
  stack.route("GET", "/rooms/{roomId}/schedules", fn);
  stack.route("POST", "/rooms/{roomId}/schedules", fn);
  stack.route("PATCH", "/rooms/{roomId}/schedules/{scheduleId}", fn);
  stack.route("DELETE", "/rooms/{roomId}/schedules/{scheduleId}", fn);
  stack.route("PUT", "/rooms/{roomId}/timezone", fn);

  new CfnOutput(stack, "ScheduleFireFnName", { value: fireFn.functionName });
  new CfnOutput(stack, "SchedulerRoleArn", { value: role.roleArn });
  new CfnOutput(stack, "ScheduleGroup", { value: groupName });
  return { groupName };
}

/** Scheduler `actions` on this group's schedules only, and SCHEDULE_GROUP to name the group. */
export function allowSchedules(stack: CoreStack, fn: NodejsFunction, groupName: string, actions: string[]) {
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: actions.map((a) => `scheduler:${a}`),
    resources: [stack.formatArn({ service: "scheduler", resource: "schedule", resourceName: `${groupName}/*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
  }));
  fn.addEnvironment("SCHEDULE_GROUP", groupName);
}
