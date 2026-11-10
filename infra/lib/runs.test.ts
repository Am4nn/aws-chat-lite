import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CoreStack } from "./core-stack.js";
import { loadConfig } from "./config.js";

let cached: Template | undefined;
const template = () => {
  if (cached) return cached;
  const config = loadConfig("local", { AWS_ENDPOINT_URL: "http://localhost:4566" });
  const stack = new CoreStack(new App(), "cl-local-core", { config, env: { account: "000000000000", region: "us-east-1" } });
  return (cached = Template.fromStack(stack));
};

const fnNamed = (name: string) => {
  const fns = Object.entries(template().findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }));
  expect(fns).toHaveLength(1);
  const [logicalId, fn] = fns[0]! as [string, any];
  return { logicalId, props: fn.Properties };
};

describe("run engine", () => {
  it("the run function is durable for 130 minutes, keeps executions 7 days and times out at 15 minutes", () => {
    const { props } = fnNamed("cl-local-run");
    expect(props.DurableConfig).toEqual({ ExecutionTimeout: 7800, RetentionPeriodInDays: 7 });
    expect(props.Timeout).toBe(900);
    expect(props.Environment.Variables).toMatchObject({ MODEL_GATEWAY: "fake" });
    expect(props.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
  });

  it("has an alias named live", () => {
    const { logicalId } = fnNamed("cl-local-run");
    const aliases = Object.values(template().findResources("AWS::Lambda::Alias")).map((a: any) => a.Properties);
    expect(aliases.find((a) => a.FunctionName.Ref === logicalId)).toMatchObject({ Name: "live" });
  });

  it("the threads Lambda may invoke the alias, and knows its name and qualifier", () => {
    const threads = fnNamed("cl-local-threads");
    expect(threads.props.Environment.Variables).toMatchObject({ RUN_FN_QUALIFIER: "live" });
    expect(threads.props.Environment.Variables.RUN_FN_NAME).toEqual({ Ref: fnNamed("cl-local-run").logicalId });
    const role = threads.props.Role["Fn::GetAtt"][0];
    const statements = Object.values(template().findResources("AWS::IAM::Policy"))
      .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const alias = Object.keys(template().findResources("AWS::Lambda::Alias"))[0];
    expect(statements).toContainEqual(expect.objectContaining({
      Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { Ref: alias },
    }));
  });
});
