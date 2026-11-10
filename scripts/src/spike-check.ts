import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useLocalEnv, FLOCI_ENDPOINT } from "./env.js";
import { assertOurFlociUp } from "./floci-owner.js";
import { keepAwsSection } from "./aws-section.js";
import { cleanStaleStacks } from "./stale.js";
import { cdk, readOutputs } from "./deploy-local.js";
import { renderReport, type CheckResult } from "./report.js";
import * as websocket from "./checks/websocket.js";
import * as sse from "./checks/sse.js";
import * as durable from "./checks/durable.js";
import * as scheduler from "./checks/scheduler.js";

const STACK = "cl-local-spike";
const ctx = ["-c", "stage=local", "-c", "spike=true"];

/** What each ❌ means for the design: the local substitute used when Floci lacks the feature. */
const SUBSTITUTES: Record<string, string> = {
  "API Gateway WebSocket": "local substitute: a small WebSocket server (scripts/) that calls the same Lambda handlers",
  "Lambda streaming (SSE)": "local substitute: a local HTTP server that calls the stream handler",
  "Lambda durable functions": "local substitute: the self-checkpointing run loop (DynamoDB checkpoints, re-invoke)",
  "EventBridge Scheduler": "local substitute: a local cron poller that invokes the target",
};

/** Floci and CDK gotchas, written into every report so a rerun never loses them. */
const SETUP_NOTES = [
  "chat-lite runs its own Floci container (`floci-chat`, volume `chat-floci-data`) on port 4566; only one project's Floci runs at a time and `npm run floci:up` refuses while another holds the port.",
  "`cdk bootstrap` and `cdk deploy` work unchanged with `AWS_ENDPOINT_URL=http://localhost:4566`.",
  "Floci serves AWS hostnames under `*.localhost.floci.io:4566` (public DNS → 127.0.0.1), over plain http/ws: execute-api as `<id>.execute-api.localhost.floci.io:4566`, Function URLs as `<id>.lambda-url.us-east-1.localhost.floci.io:4566`.",
  "WebSocket API: `$connect`/`$disconnect`/`$default` and `postToConnection` work, but the management call must go to the API's own host (`http://<apiId>.execute-api.localhost.floci.io:4566/<stage>/@connections/<id>`); Floci's main endpoint answers `UnknownOperationException`. `services/src/spike/ws.ts` `callbackEndpoint()` picks it when `AWS_ENDPOINT_URL` is set.",
  "Response streaming (Floci 2.4.0): a `RESPONSE_STREAM` Function URL returns the streamed status + headers but an **empty body** (`content-length: 0`), and `InvokeWithResponseStream` is not implemented (`UnknownOperationException`). Locally, SSE runs through a small local HTTP server calling the same handler; on AWS the Function URL streams for real.",
  "Lambda durable functions run on Floci: checkpointed steps, a durable `wait` (the function is not running), invoke by alias with `DurableExecutionName`, and `GetDurableExecution` for the result.",
  "A Lambda can start a durable execution on Floci: the threads Lambda's asynchronous `Invoke` (`InvocationType: \"Event\"`, `DurableExecutionName`) of the run function's `live` alias starts the run loop, and a failing step's retries (`createRetryStrategy`, about a second apart) replay and resume as on AWS. Locally checked by `services/src/runs/run.int.test.ts`.",
  "EventBridge Scheduler one-time `at(...)` schedules fire on Floci (a few seconds late, like AWS) with a role assumed by `scheduler.amazonaws.com`.",
  "Floci returns Function URLs as `<id>.lambda-url.us-east-1.127.0.0.1:4566`, which `new URL()` rejects; call them as `<id>.lambda-url.us-east-1.localhost.floci.io:4566`.",
  "Cognito groups work on Floci: `AdminAddUserToGroup` (npm run grant) then a fresh sign-in gives an ID token with `cognito:groups: [\"creators\"]`. The JWT issuer is `http://127.0.0.1:4566/<pool>`.",
  "CDK: naming a `WebSocketLambdaIntegration` \"Default\" collides with the `$default` route's logical ID (`SectionAlreadyContains`); use distinct names.",
  "S3 presigned URLs: a Lambda's own S3 endpoint is an address inside Docker, so URLs for the browser are signed against `S3_PUBLIC_ENDPOINT=http://localhost:4566` with path-style addressing. Floci enforces what matters here: the POST policy's `content-length-range` (an 11 MB upload gets 400), bucket CORS (an unlisted origin's preflight gets 403), and the signed `response-content-type` / `response-content-disposition` overrides on GET.",
  "CDK `autoDeleteObjects` fails on Floci: its custom-resource Lambda calls S3 on port 443 (`ECONNREFUSED`), which Floci doesn't serve. The local files bucket uses `RemovalPolicy.DESTROY` without it.",
  "Floci rewrites its whole DynamoDB store (`/app/data/dynamodb-items.json`) on every write, so writes slow down as test data piles up: about 5 ms per read but 350 ms per write at 14,000 items (8 MB). When the integration suites start timing out, reset the Floci volume (its data is disposable) and deploy again.",
  "Floci doesn't roll back a failed stack update (\"Rollback is not implemented\"): the stack stays `UPDATE_ROLLBACK_FAILED`, and `ContinueUpdateRollback` doesn't clear it. Delete the stack and deploy again (Floci data is disposable).",
];

const reportPath = fileURLToPath(new URL("../../docs/learn/floci-compat.md", import.meta.url));

function withSubstitute(r: CheckResult): CheckResult {
  return r.ok || !SUBSTITUTES[r.service] ? r : { ...r, notes: `${r.notes} → ${SUBSTITUTES[r.service]}` };
}

function teardown() {
  try { cdk(["destroy", STACK, ...ctx, "--force"]); } catch (e) { console.error(`teardown: ${(e as Error).message}`); }
}

async function main() {
  await assertOurFlociUp();
  useLocalEnv();
  await cleanStaleStacks();
  cdk(["bootstrap", "aws://000000000000/us-east-1", "-c", "stage=local"]);
  teardown(); // A spike stack left over from a failed run would make deploy report "no changes".
  const results: CheckResult[] = [];
  const t0 = Date.now();
  try {
    cdk(["deploy", STACK, ...ctx, "--require-approval", "never", "--outputs-file", "cdk.out/outputs-spike.json"]);
    results.push({ service: "CloudFormation (CDK)", feature: "deploy the spike stack", ok: true, notes: "plain `cdk deploy`", ms: Date.now() - t0 });
    const o = readOutputs(STACK, "outputs-spike.json");
    const probes: [string, typeof websocket][] = [
      ["API Gateway WebSocket", websocket], ["Lambda streaming (SSE)", sse],
      ["Lambda durable functions", durable], ["EventBridge Scheduler", scheduler],
    ];
    for (const [service, mod] of probes) {
      // One probe crashing must not skip the others.
      const rows = await mod.run(o, "local").catch((e: Error): CheckResult[] =>
        [{ service, feature: "probe ran", ok: false, notes: String(e.message ?? e), ms: 0 }]);
      for (const r of rows.map(withSubstitute)) {
        console.log(`${r.ok ? "✅" : "❌"} ${r.service}: ${r.feature} (${r.ms}ms) ${r.notes}`);
        results.push(r);
      }
    }
  } catch (e) {
    results.push({ service: "CloudFormation (CDK)", feature: "deploy the spike stack", ok: false, notes: String((e as Error).message), ms: Date.now() - t0 });
  } finally {
    const health = await fetch(`${FLOCI_ENDPOINT}/_floci/health`).then((r) => r.json()).catch(() => ({}));
    const old = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    writeFileSync(reportPath, keepAwsSection(old, renderReport(results, {
      flociVersion: (health as { version?: string }).version ?? "unknown",
      date: new Date().toISOString().slice(0, 10),
      setupNotes: SETUP_NOTES,
    })));
    console.log(`Report: ${reportPath}`);
    teardown();
  }
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
