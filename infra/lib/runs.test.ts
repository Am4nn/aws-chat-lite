import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

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
    expect(fnNamed("cl-aws-run", "aws").props.Environment.Variables).toMatchObject({
      MODEL_GATEWAY: "live", MODEL_KEYS_SECRET: "cl-aws-model-keys",
    });
  });

  it("gives the run function the local sandbox token only when the deploy passes one", () => {
    expect(fnNamed("cl-local-run").props.Environment.Variables.SANDBOX_TOKEN).toBeUndefined();
    expect(fnNamed("cl-local-run", "local", { SANDBOX_TOKEN: "t" }).props.Environment.Variables).toMatchObject({ SANDBOX_TOKEN: "t" });
  });

  it("keeps the hand-set keys secret on AWS and lets cdk destroy remove it locally", () => {
    const local = Object.values(template().findResources("AWS::SecretsManager::Secret"))[0] as any;
    expect(local.DeletionPolicy).toBe("Delete");
    const secret = Object.values(template("aws").findResources("AWS::SecretsManager::Secret"))[0] as any;
    expect(secret).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("the run function may read the model keys secret", () => {
    const secret = Object.keys(template().findResources("AWS::SecretsManager::Secret"))[0];
    const statements = statementsOf(fnNamed("cl-local-run"));
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
    const statements = statementsOf(threads);
    const alias = Object.keys(template().findResources("AWS::Lambda::Alias"))[0];
    expect(statements).toContainEqual(expect.objectContaining({
      Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { Ref: alias },
    }));
  });
});
