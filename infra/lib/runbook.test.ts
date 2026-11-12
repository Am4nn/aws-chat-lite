import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { dashboardMetrics, template } from "./test-templates.js";

const runbook = readFileSync(new URL("../../docs/runbook-aws.md", import.meta.url), "utf8");
const aws = template("aws").toJSON();
const awsText = JSON.stringify(aws);
const OUTPUTS = ["SiteUrl", "DistributionDomain", "WebFunctionUrl", "ApiUrl", "WsUrl", "StreamUrl", "UserPoolId", "OpsTopicArn", "OpsDashboardUrl"];

describe("the AWS runbook", () => {
  it("names only cl-aws resources the stack has", () => {
    // A name followed by * is a prefix pattern, such as a log group filter.
    const names = [...runbook.matchAll(/cl-aws-[a-z0-9-]+(?![a-z0-9*-])/g)].map((m) => m[0]).filter((n) => n !== "cl-aws-core");
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !awsText.includes(n))).toEqual([]);
  });

  it("names only outputs the stack has", () => {
    for (const output of OUTPUTS) {
      expect(runbook).toContain(output);
      expect(Object.keys(aws.Outputs)).toContain(output);
    }
  });

  it("says how to fill every secret the stack holds", () => {
    const secrets = Object.values(template("aws").findResources("AWS::SecretsManager::Secret")).map((s: any) => s.Properties.Name);
    expect(secrets.length).toBeGreaterThan(0);
    for (const name of secrets) expect(runbook).toContain(`\`${name}\``);
  });

  it("counts the alarms, functions and secrets the stack has", () => {
    const count = (type: string) => Object.keys(template("aws").findResources(type)).length;
    const named = Object.values(template("aws").findResources("AWS::Lambda::Function"))
      .filter((f: any) => typeof f.Properties.FunctionName === "string").length;
    expect(runbook).toContain(`${count("AWS::CloudWatch::Alarm")} of them: one errors alarm for each of the ${named} functions`);
    expect(runbook).toContain(`up to all ${count("AWS::CloudWatch::Alarm")} if you confirm`);
    expect(runbook).toContain(`$0.40 per secret, ${count("AWS::SecretsManager::Secret")} of them`);
    expect(runbook).toContain(`$0.10 per alarm, ${count("AWS::CloudWatch::Alarm")} of them`);
    expect(runbook).toContain(`${dashboardMetrics(template("aws")).length} metrics, under the 50`);
  });

  it("sets the Anthropic spend limit before any key goes in", () => {
    const [before] = runbook.split("## 2.");
    expect(before).toMatch(/Claude Console[^\n]*\$10 a month/);
  });

  it("checks for leftover function log groups without CDK's helpers, whose groups the stack never owns", () => {
    const checks = runbook.split("\n").filter((line) => line.includes("--log-group-name-prefix /aws/lambda/cl-aws- "));
    expect(checks.length).toBeGreaterThan(0);
    for (const line of checks) expect(line).toContain(`--query "logGroups[?!starts_with(logGroupName, '/aws/lambda/cl-aws-core')].logGroupName"`);
  });

  it("sets $account in every command block that uses it, since a new shell has none", () => {
    const blocks = [...runbook.matchAll(/```powershell\n([\s\S]*?)```/g)].map((m) => m[1]!).filter((b) => b.includes("$account"));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).toMatch(/^\s*\$account = aws sts get-caller-identity/m);
  });

  it("runs cdk under AWS_PROFILE, since cdk can't resolve an `aws login` session through --profile", () => {
    const cdk = runbook.split("\n").filter((line) => line.includes("npx cdk "));
    expect(cdk.length).toBeGreaterThan(0);
    for (const line of cdk) expect(line).not.toContain("--profile");
    expect(runbook).toContain("$env:AWS_PROFILE = 'ig'; $env:AWS_REGION = 'ap-southeast-2'");
  });

  it("has the heading every alarm links to", () => {
    expect(runbook).toMatch(/^## When an alarm fires$/m);
  });

  it("holds no account-specific value and never reaches past this stack", () => {
    expect(runbook).not.toMatch(/\b\d{12}\b/);
    expect(runbook).not.toMatch(/arn:aws:/);
    expect(runbook).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(runbook).not.toMatch(/--all\b|\big-aws-/);
  });
});
