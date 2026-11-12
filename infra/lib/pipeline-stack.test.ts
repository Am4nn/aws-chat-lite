import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { describe, it, expect } from "vitest";
import { addPipelineComplianceChecks } from "./compliance.js";
import { buildPipelineStack } from "./test-templates.js";

const stack = buildPipelineStack();
const t = Template.fromStack(stack);
const [pipeline] = Object.values(t.findResources("AWS::CodePipeline::Pipeline")) as any[];
const stages: any[] = pipeline.Properties.Stages;
const stage = (name: string) => stages.find((s) => s.Name === name)!;
const projectsById = Object.entries(t.findResources("AWS::CodeBuild::Project")) as [string, any][];
const projects = projectsById.map(([, p]) => p);

/** A project's buildspec. The asset project's is too big for the template, so it is a file in the cloud assembly. */
function specOf(project: any): any {
  const spec: string = project.Properties.Source.BuildSpec;
  return JSON.parse(spec.startsWith("buildspec-") ? readFileSync(join((stack.node.root as App).outdir, spec), "utf8") : spec);
}

/** The build commands of the CodeBuild project a pipeline action runs. */
function commandsOf(action: any): string[] {
  const spec = specOf(t.toJSON().Resources[action.Configuration.ProjectName.Ref]);
  return Object.values(spec.phases).flatMap((phase: any) => phase.commands ?? []);
}
const action = (stageName: string, actionName: string) => stage(stageName).Actions.find((a: any) => a.Name === actionName);

describe("the pipeline", () => {
  it("is a V2 pipeline named cl-aws-pipeline", () => {
    expect(pipeline.Properties).toMatchObject({ Name: "cl-aws-pipeline", PipelineType: "V2" });
  });

  it("starts on a push to master through the CodeConnections GitHub connection, whose ARN lives in SSM", () => {
    const [source] = stage("Source").Actions;
    expect(source.ActionTypeId).toMatchObject({ Category: "Source", Provider: "CodeStarSourceConnection" });
    expect(source.Configuration).toMatchObject({ FullRepositoryId: "Am4nn/aws-chat-lite", BranchName: "master" });
    const param = source.Configuration.ConnectionArn.Ref;
    expect(t.toJSON().Parameters[param]).toMatchObject({ Type: "AWS::SSM::Parameter::Value<String>", Default: "/chat-lite/github-connection-arn" });
  });

  it("runs the stages in order: source, synth, self-update, assets, prod", () => {
    expect(stages.map((s) => s.Name)).toEqual(["Source", "Build", "UpdatePipeline", "Assets", "Prod"]);
  });

  it("synthesizes once, after the same checks CI runs, with the account's values from SSM", () => {
    const commands = commandsOf(action("Build", "Synth")).join("\n");
    for (const step of ["npm ci", "npm run check", "npm test", "npm -w web run build:open-next"]) expect(commands).toContain(step);
    expect(commands).toMatch(/npx cdk synth -c stage=aws -c alertEmail="\$ALERT_EMAIL" -c certificateArn="\$CERTIFICATE_ARN" --strict/);
    const synth = projects.find((p) => p.Properties.Environment.EnvironmentVariables?.some((v: any) => v.Name === "ALERT_EMAIL"));
    expect(synth.Properties.Environment.EnvironmentVariables).toEqual(expect.arrayContaining([
      { Name: "ALERT_EMAIL", Type: "PARAMETER_STORE", Value: "/chat-lite/alert-email" },
      { Name: "CERTIFICATE_ARN", Type: "PARAMETER_STORE", Value: "/chat-lite/certificate-arn" },
    ]));
  });

  it("asks for approval in prod only when IAM or security groups broaden, and mails the pipeline topic", () => {
    const names = stage("Prod").Actions.map((a: any) => a.Name);
    expect(names).toEqual(expect.arrayContaining(["CheckBroadening.Check", "CheckBroadening.Confirm"]));
    expect(action("Prod", "CheckBroadening.Confirm").ActionTypeId).toMatchObject({ Category: "Approval", Provider: "Manual" });
    const vars = JSON.stringify(action("Prod", "CheckBroadening.Check").Configuration.EnvironmentVariables);
    expect(vars).toContain("NOTIFICATION_ARN");
    expect(vars).toMatch(/"Ref":"PipelineTopic[0-9A-F]{8}"/);
    t.hasResourceProperties("AWS::SNS::Topic", { TopicName: "cl-aws-pipeline" });
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
  });

  it("deploys the existing cl-aws-core stack through a change set, after the broadening check", () => {
    const prod = stage("Prod").Actions;
    const deploys = prod.filter((a: any) => a.ActionTypeId.Provider === "CloudFormation");
    expect(deploys.map((a: any) => a.Configuration.StackName)).toEqual(["cl-aws-core", "cl-aws-core"]);
    expect(deploys.map((a: any) => a.Configuration.ActionMode)).toEqual(["CHANGE_SET_REPLACE", "CHANGE_SET_EXECUTE"]);
    const confirm = action("Prod", "CheckBroadening.Confirm");
    for (const deploy of deploys) expect(deploy.RunOrder).toBeGreaterThan(confirm.RunOrder);
  });

  it("checks the site and the API after the deploy, then watches the alarms and fails on any ALARM", () => {
    const health = commandsOf(action("Prod", "HealthCheck")).join("\n");
    expect(health).toContain('"$SITE_URL/login"');
    expect(health).toContain('"$API_URL/health"');
    const env = JSON.parse(action("Prod", "HealthCheck").Configuration.EnvironmentVariables);
    expect(env.map((v: any) => v.name).sort()).toEqual(["API_URL", "SITE_URL"]);

    const watch = commandsOf(action("Prod", "WatchAlarms")).join("\n");
    expect(watch).toContain("aws cloudwatch describe-alarms --alarm-name-prefix cl-aws- --state-value ALARM");
    expect(watch).toMatch(/--output text\) \|\| exit 1$/m);
    expect(watch).toContain("exit 1; fi");
    expect(watch).toMatch(/\b900\b/);
    expect(action("Prod", "WatchAlarms").RunOrder).toBeGreaterThan(action("Prod", "HealthCheck").RunOrder);
  });

  it("mails the pipeline topic when a run fails", () => {
    t.hasResourceProperties("AWS::CodeStarNotifications::NotificationRule", {
      EventTypeIds: ["codepipeline-pipeline-pipeline-execution-failed"],
      Targets: [{ TargetType: "SNS", TargetAddress: { Ref: Match.stringLikeRegexp("^PipelineTopic") } }],
    });
  });

  it("creates the failure rule only once the topic lets the notification service publish", () => {
    const [policyId] = Object.keys(t.findResources("AWS::SNS::TopicPolicy"));
    const [rule] = Object.values(t.findResources("AWS::CodeStarNotifications::NotificationRule")) as any[];
    expect(rule.DependsOn).toContain(policyId);
  });

  it("builds on small CodeBuild machines with Node 22", () => {
    expect(projects.length).toBeGreaterThan(3);
    for (const p of projects) expect(p.Properties.Environment.ComputeType).toBe("BUILD_GENERAL1_SMALL");
    // CDK's own broadening check builds its project without the pipeline's defaults; it only runs the CDK CLI.
    const ours = projectsById.filter(([id]) => !id.startsWith("PipelinePipelinesSecurityCheck"));
    expect(ours.length).toBe(projects.length - 1);
    for (const [id, p] of ours) expect(specOf(p).phases.install["runtime-versions"], id).toEqual({ nodejs: 22 });
  });

  it("publishes every asset from one action, since each action bills a minute at least", () => {
    expect(stage("Assets").Actions).toHaveLength(1);
  });

  it("holds no long-lived credentials and needs no KMS key in one account", () => {
    for (const type of ["AWS::IAM::User", "AWS::IAM::AccessKey", "AWS::KMS::Key"]) t.resourceCountIs(type, 0);
    const vars = projects.flatMap((p) => p.Properties.Environment.EnvironmentVariables ?? []);
    expect(vars.filter((v: any) => /AWS_ACCESS_KEY|AWS_SECRET|TOKEN/.test(v.Name))).toEqual([]);
  });

  it("lets the synth read only its two SSM parameters", () => {
    const reads = (Object.values(t.findResources("AWS::IAM::Policy")) as any[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith("ssm:")));
    expect(JSON.stringify(reads)).toContain(":parameter/chat-lite/alert-email");
    expect(JSON.stringify(reads)).toContain(":parameter/chat-lite/certificate-arn");
    for (const s of reads) expect(s.Resource).not.toBe("*");
  });
});

describe("pipeline compliance", () => {
  const text = (found: { id: string; entry: { data?: unknown } }[]) => found.map((f) => `${f.id}: ${String(f.entry.data)}`);

  describe.each([
    ["with the account", {}],
    ["without credentials", { env: { region: "ap-southeast-2" } }],
  ])("%s", (_, props) => {
    const stack = buildPipelineStack(props);
    addPipelineComplianceChecks(stack);
    const annotations = Annotations.fromStack(stack);

    it("the pipeline stack passes AwsSolutions", () => {
      expect(text(annotations.findError("*", Match.stringLikeRegexp("AwsSolutions-.*")))).toEqual([]);
    });

    it("the pipeline stack has no warnings, so cdk synth --strict passes", () => {
      expect(text(annotations.findWarning("*", Match.anyValue()))).toEqual([]);
    });
  });

  it("the exceptions are narrow: a new wildcard grant in a pipeline step still fails", () => {
    const changed = buildPipelineStack();
    const role = changed.node.findChild("Pipeline").node.findAll().find((c) => c.node.path.endsWith("Prod/WatchAlarms/WatchAlarms/Role"));
    (role as iam.Role).addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["s3:*"], resources: ["*"] }));
    addPipelineComplianceChecks(changed);
    expect(text(Annotations.fromStack(changed).findError("*", Match.stringLikeRegexp("AwsSolutions-.*")))).toEqual([
      expect.stringMatching(/WatchAlarms\/Role\/DefaultPolicy\/Resource: AwsSolutions-IAM5\[Action::s3:\*\]/),
    ]);
  });
});
