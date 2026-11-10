# Step 1: Skeleton + Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working npm-workspaces repo whose CDK app deploys a minimal core stack (table + `/health`) to Floci. A spike proves, or disproves, that Floci runs the four things chat-lite's design rests on: a WebSocket API with `postToConnection`, Lambda response streaming (SSE), Lambda durable functions, and EventBridge Scheduler. A guarded real-AWS check, run only with Aman present, confirms durable functions and the AgentCore Code Interpreter in Sydney. Everything is written up in `docs/learn/floci-compat.md` and `docs/learn/01-skeleton-spikes.md`.

**Architecture:** One CDK app (`infra/`) with a `stage` context: `local` deploys to Floci, `aws` to the real account (Sydney). Lambda code lives in `services/`, bundled by local esbuild. A throwaway `SpikeStack` holds the four probes. A Node script (`scripts/src/spike-check.ts`) deploys the stack, exercises each probe through the SDK and `ws`, writes the report, and destroys the stack. The instagram-lite repo already solved most of this scaffolding; copy its patterns (named below) and change the prefix.

**Tech Stack:**
- Node 26 locally, `nodejs22.x` Lambda runtime.
- TypeScript 5, aws-cdk-lib 2.275.0, aws-cdk CLI 2.1148.0, AWS SDK v3, esbuild 0.28.2, vitest 5, tsx.
- `ws` (WebSocket client for the checks).
- Floci 2.4.0. Bump to a newer tag only if 2.4.0 fails a probe and the newer one passes; record that as a ruling.

**Spec:** `docs/superpowers/specs/2026-11-10-chat-lite-design.md` (sections "Architecture", "Floci first", "Proposed steps" item 1)

## Global Constraints

- **Project root:** `C:\Aman\Coding-Bamzii\Web Development\aws\chat-lite`. The path has a **space**: run CLIs via `spawnSync(process.execPath, [bin, ...])`, never through a shell string (copy `cdk()` from instagram-lite `scripts/src/deploy-local.ts`).
- **Stages:**
  - `local`: Floci at `http://localhost:4566`, keys `test`/`test`, region `us-east-1`.
  - `aws`: profile `ig` (`aws login --profile ig`), region `ap-southeast-2`.
  - Names are prefixed `cl-local-` / `cl-aws-`.
- **Guard (copied from instagram-lite `infra/lib/config.ts`):**
  - `stage=local` without a Floci `AWS_ENDPOINT_URL` throws.
  - `stage=aws` with `AWS_ENDPOINT_URL` set throws.
- **Floci per project:** chat-lite has its own `docker-compose.yml`: container `floci-chat`, volume `chat-floci-data`, compose project `chat-lite`, port 4566.
  - Only one project's Floci runs at a time. `npm run floci:up` fails fast with "Port 4566 is held by container <name>: stop it first (instagram-lite: npm run floci:down)" when another container owns the port.
  - The env vars are the same as instagram-lite's compose: persistent storage, `FLOCI_BASE_URL=http://127.0.0.1:4566`, the private-JWT flag, and the Docker labels set to `chat-lite`.
- **Infrastructure rules:** serverless only, with no VPC, NAT, RDS, ECS or ALB. No CDK custom resources (`BucketDeployment`, `autoDeleteObjects`, `AwsCustomResource`). `removalPolicy: DESTROY`.
- **Secrets:** none in this step. `.gitignore` already excludes `.env*` and `infra/cdk.context.json`. Before every commit, run `git diff --cached | grep -E 'AKIA|sk-ant-|ghp_|BEGIN .*PRIVATE'`; it must print nothing.
- **Real AWS:** only Task 5, run by the main session in front of Aman, never by a subagent. It deploys and destroys `cl-aws-spike` only, and the instagram-lite stack is never touched.
- **Commits:** end every message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01WeDhxLeoFE159fPGSoGCfu`.
  Local commits are fine; push to `origin` only after Aman's OK at the end of the step.
- **Learn doc:** `docs/learn/01-skeleton-spikes.md` covers what and why, a mermaid diagram, "How big companies do it", and commands to poke it. Stop for Aman's OK afterwards.

## Review Focus

1. **Accidental real-AWS deploy:** `npm run spike` (local) with a stray `AWS_PROFILE` or missing endpoint must refuse rather than hit Sydney. Pinned by `config.test.ts` ("local without Floci endpoint throws") and `env.test.ts` ("localEnv strips AWS_PROFILE").
2. **Port 4566 owned by instagram-lite's Floci:** `floci:up` must say so and stop, not start a second container that fails obscurely. Pinned by `ports.test.ts`.
3. **A probe that hangs:**
   - Applies to the WebSocket probe that never receives, and the SSE probe with no chunk.
   - Each check has a timeout and becomes a ❌ row with a note; the spike still writes the report and destroys the stack.
   - Pinned by `util.test.ts` ("withTimeout rejects after ms").
4. **Partial streaming:** if Floci buffers the whole streamed response, the SSE check must report "buffered, not streamed". Comparing first-chunk time with total time tells them apart. Pinned by `sse.test.ts` ("classifies buffered vs streamed").
5. **Real-AWS spike leaves resources behind:** `spike:aws` must destroy `cl-aws-spike` and stop the AgentCore session in `finally`, even when a check fails. Verified in Task 5 by listing stacks afterwards.

---

## File Structure

```
package.json                 workspaces: infra, services, scripts; npm scripts below
tsconfig.base.json           copy of instagram-lite's
docker-compose.yml           Floci container floci-chat (see constraints)
infra/
  package.json, cdk.json, tsconfig.json
  bin/app.ts                 -c stage, CoreStack always, SpikeStack when -c spike=true
  lib/config.ts(+test)       StageConfig, loadConfig(stage, env)
  lib/core-stack.ts(+test)   table + health Lambda + HTTP API
  lib/spike-stack.ts(+test)  the 4 probes
services/
  package.json, tsconfig.json
  src/http.ts, src/health.ts(+test)
  src/spike/ws.ts            $connect/$disconnect/$default handlers (broadcast via postToConnection)
  src/spike/sse.ts           streamifyResponse handler emitting 5 SSE events, 300 ms apart
  src/spike/durable.ts       durable handler: 3 steps + a 5 s wait, returns their outputs
  src/spike/scheduled.ts     writes {pk:"SPIKE#sched", sk:<time>} to the table
scripts/
  package.json, tsconfig.json
  src/env.ts(+test)          copy instagram-lite env.ts (FLOCI_ENDPOINT, localEnv, awsEnv, assertFlociUp)
  src/ports.ts(+test)        who holds port 4566
  src/floci-up.ts            port check, then `docker compose up -d --wait`
  src/stale.ts(+test)        copy instagram-lite stale.ts with prefix "cl-local-"
  src/deploy-local.ts        cdk(), readOutputs(), deploy CoreStack
  src/report.ts(+test)       copy instagram-lite report.ts (title/intro mention chat-lite)
  src/checks/util.ts(+test)  check(), assert(), withTimeout()
  src/checks/websocket.ts, sse.ts(+test), durable.ts, scheduler.ts
  src/spike-check.ts         local spike → docs/learn/floci-compat.md
  src/spike-aws.ts           guarded real-AWS spike → appends to docs/learn/floci-compat.md "Real AWS (Sydney)" section
docs/learn/01-skeleton-spikes.md, docs/learn/floci-compat.md, docs/learn/README.md (study list)
```

---

### Task 1: Scaffold, env and port guards, Floci compose

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `docker-compose.yml`, `scripts/package.json`, `scripts/tsconfig.json`, `scripts/src/env.ts`, `scripts/src/ports.ts`, `scripts/src/floci-up.ts`
- Test: `scripts/src/env.test.ts`, `scripts/src/ports.test.ts`

**Interfaces:**
- Produces:
  - `env.ts`: the same exports as instagram-lite's `env.ts`, with `awsEnv` defaulting to profile `ig`. `scriptStage` reads `CL_STAGE` instead of `IG_STAGE`.
  - `ports.ts`: `portOwner(dockerPsOutput: string, port: number): string | undefined`. It parses `docker ps --format "{{.Names}}\t{{.Ports}}"` lines and returns the container name publishing `0.0.0.0:<port>` or `[::]:<port>`.
  - `assertPortFree(port: number, allowed: string): void` throws the message from Global Constraints when the owner exists and isn't `allowed`.
- Root npm scripts:
  - `floci:up` → `npm -w scripts run floci-up`;
  - `floci:down` → `docker compose down`;
  - `test`, `deploy:local`, `spike`, `spike:aws`.

- [ ] **Step 1:** Write the root `package.json` (workspaces infra/services/scripts; dev deps `@types/node@^22`, `tsx@^4`, `typescript@^5`, `vitest@^5`) and `tsconfig.base.json` (copy). Write `scripts/package.json`: `type: module`, deps `@aws-sdk/client-cloudformation`, `client-ssm`, `client-lambda`, `client-dynamodb`, `client-apigatewaymanagementapi`, `client-scheduler`, `client-bedrock-agentcore`, `ws`, and devDep `@types/ws`. Run `npm install`.
- [ ] **Step 2: Write the failing tests.**
  - `env.test.ts`: copy instagram-lite's `env.test.ts`, change `IG_STAGE` to `CL_STAGE`, and keep "localEnv strips AWS_PROFILE".
  - `ports.test.ts`:
    ```ts
    it("finds the container publishing the port", () => {
      const ps = "floci\t0.0.0.0:4566->4566/tcp, [::]:4566->4566/tcp\nweb\t0.0.0.0:3000->3000/tcp";
      expect(portOwner(ps, 4566)).toBe("floci");
      expect(portOwner(ps, 4567)).toBeUndefined();
    });
    it("assertPortFree throws naming the other container", () => {
      expect(() => assertPortFree(4566, "floci-chat", "floci\t0.0.0.0:4566->4566/tcp")).toThrow(/held by container floci/);
    });
    it("assertPortFree passes for our own container", () => {
      expect(() => assertPortFree(4566, "floci-chat", "floci-chat\t0.0.0.0:4566->4566/tcp")).not.toThrow();
    });
    ```
    (`assertPortFree(port, allowed, psOutput?)`: `psOutput` defaults to running `docker ps`.)
- [ ] **Step 3:** Run `npm -w scripts test`. Expected: FAIL (modules missing).
- [ ] **Step 4:** Implement `env.ts`, `ports.ts`, and `floci-up.ts`. `floci-up.ts` calls `assertPortFree(4566, "floci-chat")`, then runs `docker compose up -d --wait` via spawnSync with no shell. Then write `docker-compose.yml` per the constraints.
- [ ] **Step 5:** Run `npm -w scripts test`. Expected: PASS. Then run `npm run floci:up`. With instagram-lite's Floci running, expect the "held by container floci" error. Run `npm --prefix "../instagram-lite" run floci:down`, run `floci:up` again, and expect `floci-chat` to be healthy (`curl -s localhost:4566/_floci/health`).
- [ ] **Step 6:** Commit with message `chore: scaffold workspaces, env + port guards, per-project Floci`.

### Task 2: Stage config and a minimal core stack on Floci

**Files:**
- Create: `infra/package.json` (aws-cdk-lib 2.275.0, constructs ^10, devDeps aws-cdk 2.1148.0, esbuild 0.28.2), `infra/cdk.json` (`"app": "npx tsx bin/app.ts"`, no context), `infra/tsconfig.json`, `infra/bin/app.ts`, `infra/lib/config.ts`, `infra/lib/core-stack.ts`, `services/package.json`, `services/tsconfig.json`, `services/src/http.ts`, `services/src/health.ts`, `scripts/src/stale.ts`, `scripts/src/deploy-local.ts`
- Test: `infra/lib/config.test.ts`, `infra/lib/core-stack.test.ts`, `services/src/health.test.ts`, `scripts/src/stale.test.ts`

**Interfaces:**
- Consumes: Task 1 `localEnv`, `assertFlociUp`.
- Produces:
  - `StageConfig { stage: "local" | "aws"; prefix: "cl-local" | "cl-aws"; isLocal: boolean; region: "us-east-1" | "ap-southeast-2" }`.
  - `loadConfig(stage, env): StageConfig`.
  - `CoreStack` with outputs `ApiUrl`, `TableName`.
  - The table `cl-<stage>-main` (pk/sk strings, gsi1 gsi1pk/gsi1sk, TTL `ttl`, stream NEW_IMAGE, PAY_PER_REQUEST, DESTROY).
  - `GET /health` → `{ ok: true, stage }`.
  - `cdk(args, env?)`, `readOutputs(stack, file?)`, `deployLocalStack()`.

- [ ] **Step 1: Write the failing tests.**
  - `config.test.ts`: copy instagram-lite's guard tests (local without Floci endpoint throws; aws with endpoint throws; local → prefix `cl-local`, region `us-east-1`; aws → `cl-aws`, `ap-southeast-2`).
  - `core-stack.test.ts`: the template has one `AWS::DynamoDB::Table` named `cl-local-main` with a StreamSpecification `NEW_IMAGE` and TTL `ttl`, plus one route `GET /health`.
  - `health.test.ts`: the handler returns 200 with `{ok:true, stage:"local"}`.
  - `stale.test.ts`: copy, with the prefix changed to `cl-local-`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement each file, following instagram-lite's `config.ts`, `core-stack.ts` (just `addFunction` + `route` helpers, table, API), `health.ts`, `http.ts`, `stale.ts` and `deploy-local.ts`. `deploy-local` assertFlociUps, cleans stale stacks, bootstraps, deploys `cl-local-core`, and prints `curl http://<apiId>.execute-api.localhost.floci.io:4566/health`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Then run `npm run deploy:local` twice. The second run is idempotent: "no changes" or success. The printed curl returns `{"ok":true,"stage":"local"}`.
- [ ] **Step 5:** Commit with message `feat: stage config + core stack (table, /health) on Floci`.

### Task 3: Spike stack with the four probes

**Files:**
- Create: `infra/lib/spike-stack.ts`, `services/src/spike/ws.ts`, `services/src/spike/sse.ts`, `services/src/spike/durable.ts`, `services/src/spike/scheduled.ts`
- Modify: `infra/bin/app.ts` (add SpikeStack `cl-<stage>-spike` when `-c spike=true`; allowed on **both** stages, because Task 5 deploys it to aws)
- Test: `infra/lib/spike-stack.test.ts`

**Interfaces:**
- Produces stack outputs:
  - `WsUrl`: the `wss://` stage URL, stage `spike`.
  - `WsCallbackUrl`: the `https://` management endpoint.
  - `SseFnName`, `SseUrl`: Function URL, `invokeMode: RESPONSE_STREAM`, `authType: NONE`; the spike only, destroyed after.
  - `DurableFnName` and `DurableFnQualifier`: durable functions are invoked by a qualified ARN (alias or version).
  - `ScheduleTargetFnName`, `TableName` (its own `cl-<stage>-spike-table`), `SchedulerRoleArn`, `SchedulerGroup` (`cl-<stage>-spike`).
- Handlers:
  - **`ws.ts`:**
    - `$connect` puts `{pk:"CONN", sk:connectionId}`.
    - `$disconnect` deletes it.
    - `$default` (body `{"say": string}`) broadcasts `{"echo": say, "from": connectionId}` to every stored connection via `PostToConnectionCommand`, with the endpoint from `requestContext.domainName` + `stage`. Locally, use `AWS_ENDPOINT_URL` when set; note it as a ruling if needed.
  - **`sse.ts`:** `awslambda.streamifyResponse`; sets `content-type: text/event-stream`; writes `id: <n>\nevent: tick\ndata: {"n":<n>}\n\n` for n=1..5, 300 ms apart. If header `last-event-id: k` is present, it starts at k+1. This is the resumable pattern in miniature.
  - **`durable.ts`:** uses the AWS Durable Execution SDK for JavaScript. Verify the package name on npm and the CDK property for durable config at build time; if `lambda.Function` has no L2 prop, use `addPropertyOverride`, and ledger the ruling. The handler runs step "a" (returns 1), waits 5 s (durable wait), runs step "b" (returns 2), and returns `{a, b, waitedMs}`.
  - **`scheduled.ts`:** puts `{pk:"SPIKE#sched", sk: new Date().toISOString()}`.

- [ ] **Step 1: Write the failing test** `spike-stack.test.ts`. It asserts:
  - one `AWS::ApiGatewayV2::Api` with `ProtocolType: WEBSOCKET` and routes `$connect`, `$disconnect`, `$default`;
  - one `AWS::Lambda::Url` with `InvokeMode: RESPONSE_STREAM`;
  - a Lambda whose properties include durable config (whatever key Step 3 settles on; assert it's present);
  - an IAM role assumable by `scheduler.amazonaws.com` with `lambda:InvokeFunction` on the target;
  - `AWS::Scheduler::ScheduleGroup` named `cl-local-spike`;
  - no `AWS::EC2::*` resources.
- [ ] **Step 2:** Run `npm -w infra test`. Expected: FAIL.
- [ ] **Step 3:** Implement the stack and handlers. Bundle with `NodejsFunction`, the same as the core stack. The ws handler gets `execute-api:ManageConnections` on the API, and both ws and scheduled get table read/write.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(spike): websocket, SSE streaming, durable, scheduler probes`.

### Task 4: Local spike checks and the Floci report

**Files:**
- Create: `scripts/src/report.ts`, `scripts/src/checks/util.ts`, `scripts/src/checks/websocket.ts`, `scripts/src/checks/sse.ts`, `scripts/src/checks/durable.ts`, `scripts/src/checks/scheduler.ts`, `scripts/src/spike-check.ts`, `docs/learn/floci-compat.md` (generated)
- Test: `scripts/src/report.test.ts`, `scripts/src/checks/util.test.ts`, `scripts/src/checks/sse.test.ts`

**Interfaces:**
- Consumes: Task 2 `cdk`, `readOutputs`; Task 3 outputs.
- Produces:
  - `withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T>` rejects with `"<what>: no result within <ms/1000>s"`.
  - `parseSse(text: string): {id: string; event: string; data: string}[]`.
  - `classifyStream(firstChunkMs: number, totalMs: number): "streamed" | "buffered"`: streamed when the first chunk arrives in under 50% of the total.
  - Each `checks/*.ts` exports `run(o: Outputs, stage: "local" | "aws"): Promise<CheckResult[]>`.
- Checks (each wrapped in `check()` + `withTimeout`):
  - **websocket:**
    - two clients connect (locally, find the working URL form and note it, e.g. `ws://<apiId>.execute-api.localhost.floci.io:4566/spike`);
    - A sends `{"say":"hi"}`, and **both** receive `{"echo":"hi"}`;
    - A closes, then B sends, and B still receives (the stale connection is handled: a `GoneException` on A is swallowed and A's record deleted);
    - notes report round-trip ms.
  - **sse:** fetch `SseUrl` (or invoke with `InvokeWithResponseStreamCommand` when the URL doesn't work locally, noting which), then:
    - parse 5 events with ids 1..5;
    - classify streamed or buffered;
    - fetch again with `last-event-id: 3`, expecting ids 4 and 5 only.
  - **durable:** invoke the qualified function, then poll until completion (via the durable-execution API or the async result, whichever the SDK supports, recorded in notes). The result should equal `{a:1, b:2}` with `waitedMs >= 5000`.
  - **scheduler:** create a one-time schedule `at(<now + 70 s>)` in the group, targeting `ScheduleTargetFnName` with `SchedulerRoleArn`, then poll the table for a `SPIKE#sched` item for up to 150 s. Delete the schedule in `finally`.
- **Every ❌ row's note** ends with the planned local substitute from the spec:
  - WebSocket: a small local WebSocket server calling the same handlers;
  - SSE: a local HTTP server calling the stream handler;
  - durable: the self-checkpointing loop;
  - scheduler: a local cron poller.

- [ ] **Step 1: Write the failing tests.**
  - `report.test.ts`: copy instagram-lite's, adapted to the chat-lite title.
  - `util.test.ts`: "withTimeout rejects after ms" (a never-resolving promise, 20 ms, `/no result within/`) and "withTimeout passes the value through".
  - `sse.test.ts`:
    - `parseSse("id: 1\nevent: tick\ndata: {\"n\":1}\n\nid: 2\nevent: tick\ndata: {\"n\":2}\n\n")` returns 2 events with ids "1" and "2";
    - "classifies buffered vs streamed": `classifyStream(100, 1500)` is `"streamed"` and `classifyStream(1450, 1500)` is `"buffered"`.
- [ ] **Step 2:** Run `npm -w scripts test`. Expected: FAIL.
- [ ] **Step 3:** Implement util, the parsers and the four checks. Then write `spike-check.ts`, modelled on instagram-lite's:
  - assertFlociUp, useLocalEnv, cleanStaleStacks, bootstrap;
  - tear down any old spike stack, then deploy `cl-local-spike` with `-c stage=local -c spike=true`;
  - run the checks, write `docs/learn/floci-compat.md` with SETUP_NOTES describing what this step learned;
  - destroy the stack in `finally`.
- [ ] **Step 4:** Run `npm -w scripts test`. Expected: PASS. Then run `npm run spike`. Expected: the report is written with 1 row for the deploy plus at least 4 probe rows. ❌ rows are acceptable: they're findings, not failures of this task. The task fails only if the spike crashes or leaves `cl-local-spike` behind (`aws cloudformation list-stacks` against Floci).
- [ ] **Step 5:** Commit with message `feat(spike): local checks + floci-compat report`, including the generated report.

### Task 5: Real-AWS check (main session, with Aman watching)

**Files:**
- Create: `scripts/src/spike-aws.ts`, `scripts/src/checks/agentcore.ts`
- Modify: `docs/learn/floci-compat.md` (the script appends or replaces a "## Real AWS (Sydney)" section; keep it idempotent between `<!-- aws:start -->` / `<!-- aws:end -->` markers)
- Test: `scripts/src/spike-aws.test.ts`

**Interfaces:**
- Consumes: Task 1 `awsEnv`; Task 2 `cdk`, `readOutputs`; Task 4 durable check (`run(o, "aws")`).
- Produces:
  - `replaceAwsSection(doc: string, section: string): string`.
  - `agentcore.run()`: starts a session on the built-in code interpreter `aws.codeinterpreter.v1` in `ap-southeast-2`, executes Python `print(6*7)`, expects `42`, and **stops the session in `finally`**. Notes include the session start latency.

- [ ] **Step 1: Write the failing test** `spike-aws.test.ts`:
  - `replaceAwsSection("a\n<!-- aws:start -->\nold\n<!-- aws:end -->\nb", "new")` contains `new` and not `old`;
  - a doc without markers gets the section appended.
- [ ] **Step 2:** Run it. Expected: FAIL. Implement it, run it again. Expected: PASS.
- [ ] **Step 3:** Implement `spike-aws.ts`:
  - **Setup:** `useAwsEnv()` and print the account and region from `sts get-caller-identity`.
  - **Bootstrap:** use `cdk bootstrap` only if the `CDKToolkit` stack is missing; it exists from instagram-lite.
  - **Deploy and check:** deploy **only** `cl-aws-spike`, then run the durable, SSE (Function URL streaming), WebSocket, scheduler and agentcore checks.
  - **Report:** write the section.
  - **Clean up:** `cdk destroy cl-aws-spike --force` in `finally`.
- [ ] **Step 4 (Aman present):**
  - **Before running:** Aman runs `aws login --profile ig` if the session expired; show him the command first.
  - **Run:** `npm run spike:aws`. Expected: the report section is written, and each row shows ✅ or ❌ with a reason. An "AccessDenied/not available" ❌ is a valid finding: it triggers the spec's fallback, which gets recorded in the learn doc.
  - **Afterwards:** run `aws cloudformation list-stacks --profile ig --region ap-southeast-2 --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE` and confirm no `cl-aws-*` stack remains.
  - **Cost:** cents at most.
- [ ] **Step 5:** Commit with message `feat(spike): real-AWS check for durable functions + AgentCore (Sydney)`.

### Task 6: Learn doc, README, and the stop

**Files:**
- Create: `docs/learn/01-skeleton-spikes.md`, `docs/learn/README.md` (study list, started)
- Modify: `README.md` (run-locally commands: `floci:up`, `deploy:local`, `spike`, `spike:aws`, `test`)

- [ ] **Step 1:** Write `01-skeleton-spikes.md`. It covers:
  - why we spike first;
  - what each probe proves (WebSocket fan-out, SSE resume with `Last-Event-ID`, durable checkpoint and replay, Scheduler);
  - a mermaid diagram of the spike stack;
  - the Floci vs real-AWS results table, linking to `floci-compat.md`;
  - which fallbacks, if any, the design now uses;
  - "How big companies do it" (Slack's and Discord's WebSocket gateways, ChatGPT's resumable streams, Temporal/durable execution);
  - commands to poke it.
- [ ] **Step 2:** Run `npm test`. Expected: all pass. Then run the secret scan from Global Constraints. Expected: no output.
- [ ] **Step 3:** Commit with message `docs: step 1 learn doc + README`. Stop: give Aman a short chat explainer and wait for his OK. Push to `origin master` only after he says so.
