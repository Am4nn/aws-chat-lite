import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

describe("sandbox infrastructure", () => {
  it("on AWS makes an offline and an online interpreter, neither with an execution role", () => {
    const found = Object.values(template("aws").findResources("AWS::BedrockAgentCore::CodeInterpreterCustom")) as any[];
    expect(found).toHaveLength(2);
    const byName = Object.fromEntries(found.map((r) => [r.Properties.Name, r.Properties]));
    expect(Object.keys(byName).sort()).toEqual(["cl_aws_sandbox_offline", "cl_aws_sandbox_online"]);
    for (const name of Object.keys(byName)) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(byName.cl_aws_sandbox_offline.NetworkConfiguration.NetworkMode).toBe("SANDBOX");
    expect(byName.cl_aws_sandbox_online.NetworkConfiguration.NetworkMode).toBe("PUBLIC");
    for (const p of Object.values(byName) as any[]) expect(p.ExecutionRoleArn).toBeUndefined();
  });

  it("on AWS the run function gets the interpreter ids and exactly three actions on exactly those two", () => {
    const fn = fnNamed("cl-aws-run", "aws");
    const env = fn.props.Environment.Variables;
    expect(env.SANDBOX_KIND).toBe("agentcore");
    expect(env.SANDBOX_OFFLINE_ID).toBeDefined();
    expect(env.SANDBOX_ONLINE_ID).toBeDefined();
    const stmts = statementsOf(fn, "aws")
      .filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith("bedrock-agentcore:")));
    expect(stmts).toHaveLength(1);
    expect([stmts[0].Action].flat().sort()).toEqual([
      "bedrock-agentcore:InvokeCodeInterpreter", "bedrock-agentcore:StartCodeInterpreterSession", "bedrock-agentcore:StopCodeInterpreterSession",
    ]);
    expect(stmts[0].Resource).toHaveLength(2);
  });

  it("locally makes no interpreter and points the run function at the Docker sandbox", () => {
    expect(Object.keys(template().findResources("AWS::BedrockAgentCore::CodeInterpreterCustom"))).toEqual([]);
    const env = fnNamed("cl-local-run").props.Environment.Variables;
    expect(env).toMatchObject({ SANDBOX_KIND: "docker", SANDBOX_URL: "http://host.docker.internal:4700" });
    expect(env.SANDBOX_OFFLINE_ID).toBeUndefined();
  });
});
