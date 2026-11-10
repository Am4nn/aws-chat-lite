import { LambdaClient, InvokeCommand, GetDurableExecutionCommand, ListDurableExecutionsByFunctionCommand } from "@aws-sdk/client-lambda";
import { check, withTimeout, assert, sleep, type Outputs } from "./util.js";

async function waitForResult(lambda: LambdaClient, o: Outputs, name: string, arn: string | undefined): Promise<string> {
  for (;;) {
    let exec = arn;
    if (!exec) {
      const list = await lambda.send(new ListDurableExecutionsByFunctionCommand({
        FunctionName: o.DurableFnName, Qualifier: o.DurableFnQualifier, DurableExecutionName: name,
      }));
      exec = list.DurableExecutions?.[0]?.DurableExecutionArn;
    }
    if (exec) {
      const r = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: exec }));
      if (r.Status === "SUCCEEDED") return r.Result ?? "";
      if (r.Status && r.Status !== "RUNNING") throw new Error(`execution ${r.Status}: ${JSON.stringify(r.Error ?? {})}`);
    }
    await sleep(1000);
  }
}

export async function run(o: Outputs) {
  const lambda = new LambdaClient({});
  return [
    await check("Lambda durable functions", "steps + a 5 s durable wait complete with checkpointed results", async () => {
      const name = `spike-${Date.now()}`;
      const t0 = Date.now();
      const inv = await lambda.send(new InvokeCommand({
        FunctionName: o.DurableFnName, Qualifier: o.DurableFnQualifier, InvocationType: "Event",
        DurableExecutionName: name, Payload: Buffer.from("{}"),
      }));
      const raw = await withTimeout(waitForResult(lambda, o, name, inv.DurableExecutionArn), 90_000, "durable execution");
      const result = JSON.parse(raw);
      assert(result.a === 1 && result.b === 2, `unexpected result ${raw}`);
      assert(result.waitedMs >= 5000, `waited only ${result.waitedMs} ms`);
      return `result ${raw}, total ${Date.now() - t0} ms`;
    }),
  ];
}
