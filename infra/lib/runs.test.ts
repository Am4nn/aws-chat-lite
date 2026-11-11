import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CoreStack } from "./core-stack.js";
import { loadConfig } from "./config.js";

const FLOCI = { AWS_ENDPOINT_URL: "http://localhost:4566" };
const cached = new Map<string, Template>();
const template = (env: NodeJS.ProcessEnv = FLOCI) => {
  const key = JSON.stringify(env);
  if (!cached.has(key)) {
    const config = loadConfig("local", env);
    const stack = new CoreStack(new App(), "cl-local-core", { config, env: { account: "000000000000", region: "us-east-1" } });
    cached.set(key, Template.fromStack(stack));
  }
  return cached.get(key)!;
};

const fnNamed = (name: string, env?: NodeJS.ProcessEnv) => {
  const fns = Object.entries(template(env).findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }));
  expect(fns).toHaveLength(1);
  const [logicalId, fn] = fns[0]! as [string, any];
  return { logicalId, props: fn.Properties };
};

const statementsOf = (role: string) =>
  Object.values(template().findResources("AWS::IAM::Policy"))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);

describe("run engine", () => {
  it("the run function is durable for 130 minutes, keeps executions 7 days, times out at 15 minutes and has 1 GB", () => {
    const { props } = fnNamed("cl-local-run");
    expect(props.DurableConfig).toEqual({ ExecutionTimeout: 7800, RetentionPeriodInDays: 7 });
    expect(props.Timeout).toBe(900);
    expect(props.MemorySize).toBe(1024);
    expect(props.Environment.Variables).toMatchObject({ MODEL_GATEWAY: "fake" });
    expect(props.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
  });

  it("knows where its model keys are, and serves real models only when the stage asks", () => {
    const secrets = Object.entries(template().findResources("AWS::SecretsManager::Secret", { Properties: { Name: "cl-local-model-keys" } }));
    expect(secrets).toHaveLength(1);
    expect(fnNamed("cl-local-run").props.Environment.Variables).toMatchObject({
      MODEL_GATEWAY: "fake", MODEL_KEYS_SECRET: "cl-local-model-keys",
    });
    expect(fnNamed("cl-local-run", { ...FLOCI, MODEL_GATEWAY: "live" }).props.Environment.Variables).toMatchObject({
      MODEL_GATEWAY: "live", MODEL_KEYS_SECRET: "cl-local-model-keys",
    });
  });

  it("gives the run function the local sandbox token only when the deploy passes one", () => {
    expect(fnNamed("cl-local-run").props.Environment.Variables.SANDBOX_TOKEN).toBeUndefined();
    expect(fnNamed("cl-local-run", { ...FLOCI, SANDBOX_TOKEN: "t" }).props.Environment.Variables).toMatchObject({ SANDBOX_TOKEN: "t" });
  });

  it("keeps the hand-set keys secret on AWS and lets cdk destroy remove it locally", () => {
    const local = Object.values(template().findResources("AWS::SecretsManager::Secret"))[0] as any;
    expect(local.DeletionPolicy).toBe("Delete");
    const config = loadConfig("aws", {});
    const aws = Template.fromStack(new CoreStack(new App(), "cl-aws-core", { config, env: { account: "111111111111", region: "ap-southeast-2" } }));
    const secret = Object.values(aws.findResources("AWS::SecretsManager::Secret"))[0] as any;
    expect(secret).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("the run function may read the model keys secret", () => {
    const { props } = fnNamed("cl-local-run");
    const secret = Object.keys(template().findResources("AWS::SecretsManager::Secret"))[0];
    const statements = statementsOf(props.Role["Fn::GetAtt"][0]);
    expect(statements).toContainEqual(expect.objectContaining({
      Action: expect.arrayContaining(["secretsmanager:GetSecretValue"]), Effect: "Allow", Resource: { Ref: secret },
    }));
  });

  it("no Lambda holds an API key in its environment", () => {
    const names = Object.values(template().findResources("AWS::Lambda::Function"))
      .flatMap((fn: any) => Object.keys(fn.Properties.Environment?.Variables ?? {}));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => /API_KEY/.test(n))).toEqual([]);
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
    const statements = statementsOf(threads.props.Role["Fn::GetAtt"][0]);
    const alias = Object.keys(template().findResources("AWS::Lambda::Alias"))[0];
    expect(statements).toContainEqual(expect.objectContaining({
      Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { Ref: alias },
    }));
  });
});
