import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

describe("run engine", () => {
  it("the run function is durable for 7 days (a write can wait that long for approval), keeps executions 7 days, times out at 15 minutes and has 1 GB", () => {
    const { props } = fnNamed("cl-local-run");
    expect(props.DurableConfig).toEqual({ ExecutionTimeout: 7 * 24 * 3600, RetentionPeriodInDays: 7 });
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

  it("knows where its tool keys are, and calls real tools only when the stage asks", () => {
    const secrets = Object.entries(template().findResources("AWS::SecretsManager::Secret", { Properties: { Name: "cl-local-tool-keys" } }));
    expect(secrets).toHaveLength(1);
    expect(fnNamed("cl-local-run").props.Environment.Variables).toMatchObject({ TOOL_MODE: "fake", TOOL_KEYS_SECRET: "cl-local-tool-keys" });
    expect(fnNamed("cl-local-run", "local", { TOOL_MODE: "live" }).props.Environment.Variables).toMatchObject({ TOOL_MODE: "live" });
  });

  it("gives the run function the local sandbox token only when the deploy passes one", () => {
    expect(fnNamed("cl-local-run").props.Environment.Variables.SANDBOX_TOKEN).toBeUndefined();
    expect(fnNamed("cl-local-run", "local", { SANDBOX_TOKEN: "t" }).props.Environment.Variables).toMatchObject({ SANDBOX_TOKEN: "t" });
  });

  it("keeps the keys secrets on AWS and lets cdk destroy remove them locally", () => {
    const local = Object.values(template().findResources("AWS::SecretsManager::Secret")) as any[];
    expect(local.map((s) => s.DeletionPolicy)).toEqual(["Delete", "Delete", "Delete"]);
    const secrets = Object.values(template("aws").findResources("AWS::SecretsManager::Secret"));
    expect(secrets).toHaveLength(3);
    for (const secret of secrets) expect(secret).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  const secretId = (name: string) => Object.keys(template().findResources("AWS::SecretsManager::Secret", { Properties: { Name: name } }))[0];
  const secretReads = (fn: string) => statementsOf(fnNamed(fn))
    .filter((s: any) => [s.Action].flat().includes("secretsmanager:GetSecretValue"))
    .map((s: any) => s.Resource.Ref);

  it("the run function may read the keys secrets and the token key, the connections function only the tool keys, and no one else either", () => {
    const run = ["cl-local-model-keys", "cl-local-tool-keys", "cl-local-token-key"].map(secretId);
    expect(secretReads("cl-local-run").sort()).toEqual(run.sort());
    expect(secretReads("cl-local-connections")).toEqual([secretId("cl-local-tool-keys")]);
    expect(secretReads("cl-local-threads")).toEqual([]);
  });

  it("no Lambda holds a key in its environment, only the names of the secrets that do", () => {
    for (const env of [{}, { MODEL_GATEWAY: "live", TOOL_MODE: "live" }]) {
      const names = Object.values(template("local", env).findResources("AWS::Lambda::Function"))
        .flatMap((fn: any) => Object.keys(fn.Properties.Environment?.Variables ?? {}));
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => /KEY|PEM/.test(n) && !n.endsWith("_SECRET"))).toEqual([]);
    }
  });

  it("the threads, live and run Lambdas may wake a waiting run, only on the run function, which is named rather than referenced", () => {
    // The run function wakes itself, and a reference to its own ARN in its own role would be a dependency cycle.
    for (const name of ["cl-local-threads", "cl-local-live", "cl-local-run"]) {
      const callbacks = statementsOf(fnNamed(name))
        .filter((s: any) => [s.Action].flat().includes("lambda:SendDurableExecutionCallbackSuccess"));
      expect(callbacks, name).toHaveLength(1);
      const [fn, executions] = callbacks[0].Resource.map((r: unknown) => JSON.stringify(r));
      expect(fn, name).toMatch(/:function:cl-local-run"\]\]\}$/);
      expect(executions, name).toMatch(/:function:cl-local-run:\*"\]\]\}$/);
    }
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
