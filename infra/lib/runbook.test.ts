import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { template } from "./test-templates.js";

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
