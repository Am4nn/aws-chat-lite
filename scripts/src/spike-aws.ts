/**
 * Real-AWS spike (Sydney): run ONLY with Aman watching. Deploys the throwaway stack cl-aws-spike,
 * checks the same probes as the Floci spike + AgentCore's built-in sandbox, writes the
 * "Real AWS (Sydney)" section of docs/learn/floci-compat.md, and always destroys the stack.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { awsEnv, useAwsEnv, AWS_STAGE_REGION } from "./env.js";
import { cdk, readOutputs } from "./cdk.js";
import { run } from "./cli.js";
import { replaceAwsSection, finishAwsSpike } from "./aws-section.js";
import { resultsTable, type CheckResult } from "./report.js";
import * as websocket from "./checks/websocket.js";
import * as sse from "./checks/sse.js";
import * as durable from "./checks/durable.js";
import * as scheduler from "./checks/scheduler.js";
import * as agentcore from "./checks/agentcore.js";

const STACK = "cl-aws-spike";
const ctx = ["-c", "stage=aws", "-c", "spike=true"];
const reportPath = fileURLToPath(new URL("../../docs/learn/floci-compat.md", import.meta.url));

async function main() {
  const env = awsEnv(process.env); // refuses an emulator endpoint or Floci's fake keys
  useAwsEnv();
  const who = await new STSClient({}).send(new GetCallerIdentityCommand({}));
  console.log(`Real AWS: account ${who.Account}, region ${AWS_STAGE_REGION}, profile ${env.AWS_PROFILE}`);
  const hasToolkit = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: "CDKToolkit" }))
    .then(() => true, () => false);
  if (!hasToolkit) cdk(["bootstrap", `aws://${who.Account}/${AWS_STAGE_REGION}`, "-c", "stage=aws"], env);

  const results: CheckResult[] = [];
  const t0 = Date.now();
  try {
    cdk(["deploy", STACK, ...ctx, "--require-approval", "never", "--outputs-file", "cdk.out/outputs-aws-spike.json"], env);
    results.push({ service: "CloudFormation (CDK)", feature: "deploy the spike stack", ok: true, notes: "", ms: Date.now() - t0 });
    const o = readOutputs(STACK, "outputs-aws-spike.json");
    const probes: [string, () => Promise<CheckResult[]>][] = [
      ["API Gateway WebSocket", () => websocket.run(o, "aws")], ["Lambda streaming (SSE)", () => sse.run(o, "aws")],
      ["Lambda durable functions", () => durable.run(o)], ["EventBridge Scheduler", () => scheduler.run(o)],
      ["AgentCore Code Interpreter", () => agentcore.run()],
    ];
    for (const [service, probe] of probes) {
      const rows = await probe().catch((e: Error): CheckResult[] => [{ service, feature: "probe ran", ok: false, notes: e.message, ms: 0 }]);
      for (const r of rows) {
        console.log(`${r.ok ? "✅" : "❌"} ${r.service}: ${r.feature} (${r.ms}ms) ${r.notes}`);
        results.push(r);
      }
    }
  } catch (e) {
    results.push({ service: "CloudFormation (CDK)", feature: "deploy the spike stack", ok: false, notes: (e as Error).message, ms: Date.now() - t0 });
  } finally {
    const section = [
      "## Real AWS (Sydney)",
      "",
      `Run by \`npm run spike:aws\` on ${new Date().toISOString().slice(0, 10)}, region ${AWS_STAGE_REGION}; the stack is destroyed afterwards.`,
      "",
      ...resultsTable(results),
    ].join("\n");
    process.exitCode = finishAwsSpike({
      destroy: () => cdk(["destroy", STACK, ...ctx, "--force"], env),
      writeReport: () => {
        writeFileSync(reportPath, replaceAwsSection(readFileSync(reportPath, "utf8"), section));
        console.log(`Report: ${reportPath}`);
      },
      log: (l) => console.error(l),
    });
  }
}

// Ctrl+C mid-deploy skips the finally above: say how to clean up by hand.
process.once("SIGINT", () => {
  console.error("\nInterrupted. If cl-aws-spike was created, remove it: cd infra && npx cdk destroy cl-aws-spike -c stage=aws -c spike=true --profile ig");
  process.exit(130);
});

run(main);
