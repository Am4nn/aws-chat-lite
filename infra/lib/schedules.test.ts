import { describe, it, expect } from "vitest";
import { fnNamed, jwtRoutesOf, statementsOf, template } from "./test-templates.js";

const ROUTES = [
  "GET /rooms/{roomId}/schedules", "POST /rooms/{roomId}/schedules", "PATCH /rooms/{roomId}/schedules/{scheduleId}",
  "DELETE /rooms/{roomId}/schedules/{scheduleId}", "PUT /rooms/{roomId}/timezone",
];

const schedulerRole = () => {
  const roles = Object.entries(template().findResources("AWS::IAM::Role")).filter(([, r]: [string, any]) =>
    JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes("scheduler.amazonaws.com"));
  expect(roles).toHaveLength(1);
  const [logicalId, role] = roles[0]! as [string, any];
  return { logicalId, role };
};

const policiesOf = (roleId: string) => Object.values(template().findResources("AWS::IAM::Policy"))
  .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
  .flatMap((p: any) => p.Properties.PolicyDocument.Statement);

const schedulerActions = (fn: ReturnType<typeof fnNamed>) =>
  statementsOf(fn).filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith("scheduler:")));

describe("schedules", () => {
  it("has the schedule group", () => {
    template().hasResourceProperties("AWS::Scheduler::ScheduleGroup", { Name: "cl-local-agent-schedules" });
  });

  it("one Lambda serves the schedules and time zone routes, behind the JWT authorizer, with 15 s", () => {
    const fn = fnNamed("cl-local-schedules");
    expect(jwtRoutesOf(fn.logicalId).sort()).toEqual([...ROUTES].sort());
    expect(fn.props.Timeout).toBe(15);
  });

  it("Scheduler assumes its role only for this account, and the role may only invoke the fire function", () => {
    const { logicalId, role } = schedulerRole();
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([expect.objectContaining({
      Action: "sts:AssumeRole", Principal: { Service: "scheduler.amazonaws.com" },
      Condition: { StringEquals: { "aws:SourceAccount": "000000000000" } },
    })]);
    const statements = policiesOf(logicalId);
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe("lambda:InvokeFunction");
    const fire = fnNamed("cl-local-schedule-fire").logicalId;
    for (const r of statements[0].Resource) expect(JSON.stringify(r)).toContain(fire);
  });

  it("the schedules function manages schedules in the group, passes only the scheduler role, and names both and the target", () => {
    const fn = fnNamed("cl-local-schedules");
    const [manage] = schedulerActions(fn);
    expect([manage.Action].flat().sort()).toEqual(["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule"]);
    expect(JSON.stringify(manage.Resource)).toMatch(/:schedule\/cl-local-agent-schedules\/\*"\]\]\}$/);
    const passRole = statementsOf(fn).filter((s: any) => [s.Action].flat().includes("iam:PassRole"));
    expect(passRole).toHaveLength(1);
    expect(passRole[0].Resource).toEqual({ "Fn::GetAtt": [schedulerRole().logicalId, "Arn"] });
    const env = fn.props.Environment.Variables;
    expect(env.SCHEDULE_GROUP).toBe("cl-local-agent-schedules");
    expect(env.SCHEDULER_ROLE_ARN).toEqual({ "Fn::GetAtt": [schedulerRole().logicalId, "Arn"] });
    expect(env.SCHEDULE_TARGET_ARN).toEqual({ "Fn::GetAtt": [fnNamed("cl-local-schedule-fire").logicalId, "Arn"] });
  });

  it("the fire function has 30 s, may start runs and tell the room, and on Scheduler only delete in the group", () => {
    const fn = fnNamed("cl-local-schedule-fire");
    expect(fn.props.Timeout).toBe(30);
    expect(fn.props.Environment.Variables).toMatchObject({ SCHEDULE_GROUP: "cl-local-agent-schedules", RUN_FN_QUALIFIER: "live" });
    expect(fn.props.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
    const [remove, ...others] = schedulerActions(fn);
    expect(others).toEqual([]);
    expect(remove.Action).toBe("scheduler:DeleteSchedule");
  });

  it("outputs the fire function, the scheduler role and the group", () => {
    for (const name of ["ScheduleFireFnName", "SchedulerRoleArn", "ScheduleGroup"]) expect(Object.keys(template().findOutputs(name)), name).toHaveLength(1);
  });
});
