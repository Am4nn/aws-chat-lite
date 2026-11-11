import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CoreStack } from "./core-stack.js";
import { loadConfig } from "./config.js";

const build = (stage: "local" | "aws") => {
  const config = loadConfig(stage, stage === "local" ? { AWS_ENDPOINT_URL: "http://localhost:4566" } : {});
  const stack = new CoreStack(new App(), `cl-${stage}-core`, { config, env: { account: "123456789012", region: config.region } });
  return Template.fromStack(stack);
};

const runFn = (t: Template, name: string) =>
  Object.values(t.findResources("AWS::Lambda::Function")).find((f: any) => f.Properties.FunctionName === name) as any;

describe("sandbox infrastructure", () => {
  it("on AWS makes an offline and an online interpreter, neither with an execution role", () => {
    const t = build("aws");
    const found = Object.values(t.findResources("AWS::BedrockAgentCore::CodeInterpreterCustom")) as any[];
    expect(found).toHaveLength(2);
    const byName = Object.fromEntries(found.map((r) => [r.Properties.Name, r.Properties]));
    expect(Object.keys(byName).sort()).toEqual(["cl_aws_sandbox_offline", "cl_aws_sandbox_online"]);
    for (const name of Object.keys(byName)) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(byName.cl_aws_sandbox_offline.NetworkConfiguration.NetworkMode).toBe("SANDBOX");
    expect(byName.cl_aws_sandbox_online.NetworkConfiguration.NetworkMode).toBe("PUBLIC");
    for (const p of Object.values(byName) as any[]) expect(p.ExecutionRoleArn).toBeUndefined();
  });

  it("on AWS the run function gets the interpreter ids and exactly three actions on exactly those two", () => {
    const t = build("aws");
    const fn = runFn(t, "cl-aws-run");
    const env = fn.Properties.Environment.Variables;
    expect(env.SANDBOX_KIND).toBe("agentcore");
    expect(env.SANDBOX_OFFLINE_ID).toBeDefined();
    expect(env.SANDBOX_ONLINE_ID).toBeDefined();
    const roleRef = fn.Properties.Role["Fn::GetAtt"][0];
    const stmts = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === roleRef))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith("bedrock-agentcore:")));
    expect(stmts).toHaveLength(1);
    expect([stmts[0].Action].flat().sort()).toEqual([
      "bedrock-agentcore:InvokeCodeInterpreter", "bedrock-agentcore:StartCodeInterpreterSession", "bedrock-agentcore:StopCodeInterpreterSession",
    ]);
    expect(stmts[0].Resource).toHaveLength(2);
  });

  it("locally makes no interpreter and points the run function at the Docker sandbox", () => {
    const t = build("local");
    expect(Object.keys(t.findResources("AWS::BedrockAgentCore::CodeInterpreterCustom"))).toEqual([]);
    const env = runFn(t, "cl-local-run").Properties.Environment.Variables;
    expect(env).toMatchObject({ SANDBOX_KIND: "docker", SANDBOX_URL: "http://host.docker.internal:4700" });
    expect(env.SANDBOX_OFFLINE_ID).toBeUndefined();
  });
});
