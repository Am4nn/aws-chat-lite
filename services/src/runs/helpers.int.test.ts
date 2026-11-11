import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { GetDurableExecutionHistoryCommand, LambdaClient, ListDurableExecutionsByFunctionCommand } from "@aws-sdk/client-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { agentsRepo } from "../agents/repo.js";
import { decideApproval } from "../approvals/decide.js";
import { chatRepo } from "../chat/repo.js";
import type { Attachment } from "../chat/model.js";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { summaryLine } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { Agent, RunEvent, ToolKind } from "../threads/types.js";
import { answerOf } from "./context.js";
import { runsRepo } from "./repo.js";
import { startOrSteer } from "./start.js";
import { requestStop } from "./stop.js";

// Runs against the deployed run function on Floci, in fake model and tool modes: npm run deploy:local, then this file.
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

const runs = runsRepo();
const threads = threadsRepo();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let clients = 0;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** The run once it has closed and written `run.finished`, which follows the close. */
const finished = (runId: string, ms?: number) =>
  until("the run to end", async () => {
    const run = await runs.getRun(runId);
    if (!run || run.status === "running") return undefined;
    return (await runs.allEvents(runId)).at(-1)?.type === "run.finished" ? run : undefined;
  }, ms);

const ofType = <T extends RunEvent["type"]>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
const laneOf = (e: RunEvent) => e.lane ?? 0;
const answers = (text: string) => text.match(/Fake answer for/g)?.length ?? 0;

/** A room with `lead`, whose threads these runs answer, and `researcher`, which lead delegates to. */
async function room({ researcherTools = ["web"], researcherModel = "room", github = false }: {
  researcherTools?: ToolKind[]; researcherModel?: Agent["model"]; github?: boolean;
} = {}) {
  const owner = { userId: randomUUID(), username: "owner" };
  const { roomId } = await roomsRepo().createRoom(owner, "Helpers");
  const agents = agentsRepo();
  const lead = await agents.create(owner, roomId, { name: "lead", instructions: "Lead the work.", tools: ["web"], model: "room" });
  await agents.create(owner, roomId, {
    name: "researcher", instructions: "Find sources.", tools: researcherTools, model: researcherModel,
  });
  if (github) {
    await docClient().send(new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `ROOM#${roomId}`, sk: "LINK#github", installationId: 1, account: "fake-org", repos: ["fake-org/playground"],
        addedBy: "owner", addedAt: new Date().toISOString(),
      },
    }));
  }
  return { owner, roomId, lead };
}

/** A thread of lead's whose first message (with any files, as already checked) starts a run. */
async function leadRun(at: Awaited<ReturnType<typeof room>>, text: string, attachments: Attachment[] = []) {
  const { thread, message } = await threads.createThread(at.owner, at.roomId, {
    text, clientId: `k${++clients}`, admitted: { text, attachments }, agentId: at.lead.agentId,
  });
  const { runId } = await startOrSteer(at.owner, at.roomId, thread.threadId, message);
  return { thread, runId };
}

const lambda = new LambdaClient({});

/** The name of every step the run's durable execution started, once per start, from the execution's own history. */
async function stepStarts(runId: string): Promise<string[]> {
  const { DurableExecutions = [] } = await lambda.send(new ListDurableExecutionsByFunctionCommand({
    FunctionName: "cl-local-run", Qualifier: "live", DurableExecutionName: runId,
  }));
  const history = await lambda.send(new GetDurableExecutionHistoryCommand({
    DurableExecutionArn: DurableExecutions[0]!.DurableExecutionArn!, IncludeExecutionData: false, MaxItems: 1000,
  }));
  return (history.Events ?? []).filter((e) => e.EventType === "StepStarted").map((e) => e.Name ?? "");
}

// Each durable step checkpoints through Floci, which takes up to a second or two while other suites share it.
describe("helper agents in their own lanes of the run, on Floci", { timeout: 120_000 }, () => {
  it("lead hands researcher a task: its steps and answer go in lane 1, and only its answer reaches lead", async () => {
    const at = await room();
    const { thread, runId } = await leadRun(at, "ask:researcher go");
    const run = await finished(runId);
    const events = await runs.allEvents(runId);
    expect(run.status).toBe("done");

    const order = events.filter((e) => /^(step|helper)\.|^text$/.test(e.type)).map((e) => `${laneOf(e)}:${e.type}`);
    expect(order.filter((k, i) => k !== order[i - 1])).toEqual([
      "0:step.started", "1:helper.started",
      "1:step.started", "1:step.finished", "1:step.started", "1:step.finished", "1:text", "1:helper.finished",
      "0:step.finished", "0:text",
    ]);
    expect(ofType(events, "helper.started")).toMatchObject([{ lane: 1, step: 1, agentName: "researcher", task: "go" }]);
    expect(ofType(events, "helper.finished")).toMatchObject([{ lane: 1, step: 1, status: "done", steps: 2 }]);

    // The helper's answer is lead's delegate result, and nowhere in lead's own answer or its card.
    const delegated = ofType(events, "step.finished").find((e) => e.step === 1)!;
    expect(delegated).toMatchObject({ ok: true, output: answerOf(events, 1).text });
    const main = answerOf(events, 0);
    const stored = (await chatRepo().history(at.owner, at.roomId, thread.threadId, {})).messages.filter((m) => m.authorId === "agent").at(-1)!;
    expect(stored.text).toBe(main.text);
    expect(answers(stored.text)).toBe(1);
    expect((await threads.threadById(at.roomId, thread.threadId))!.summary).toBe(summaryLine(main.final));

    // The delegate step and the helper's two lookups share the run's step count and its cost. Step numbers are the
    // run's, not the lane's, so what is keyed by step (an image's staging object and file, its "already billed" check)
    // never meets another lane's.
    expect(run.steps).toBe(3);
    expect(ofType(events, "step.started").map((e) => e.step)).toEqual([1, 2, 3]);
    expect(run.costMicros).toBe(ofType(events, "usage").reduce((sum, e) => sum + e.costMicros, 0));
  });

  it("a stop while the helper works ends the helper and the run", async () => {
    const at = await room();
    const { thread, runId } = await leadRun(at, "ask:researcher go slow");
    await until("the helper's first step", async () =>
      (await runs.allEvents(runId)).find((e) => e.type === "step.started" && laneOf(e) === 1));
    const stoppedAt = Date.now();
    await requestStop(at.owner, at.roomId, thread.threadId);
    expect((await finished(runId, 20_000)).status).toBe("stopped");
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    const events = await runs.allEvents(runId);
    expect(ofType(events, "helper.finished")).toMatchObject([{ status: "stopped" }]);
    expect(ofType(events, "step.finished").find((e) => e.step === 1)).toMatchObject({
      ok: false, output: "@researcher couldn't finish: Stopped by owner.",
    });
  });

  it("a helper whose own model may not see the thread's files gets one that may", async () => {
    const at = await room({ researcherModel: "deepseek-flash" });
    const file: Attachment = { key: `rooms/${at.roomId}/u/f/report.pdf`, name: "report.pdf", size: 1, type: "application/pdf" };
    const { runId } = await leadRun(at, "ask:researcher go tools:0", [file]);
    expect((await finished(runId)).status).toBe("done");
    expect(ofType(await runs.allEvents(runId), "helper.started")[0]!.model).toMatch(/^claude-/);
  });

  it("an agent the room doesn't have is refused as the delegate's result, and lead carries on", async () => {
    const at = await room();
    const { runId } = await leadRun(at, "ask:nobody go");
    expect((await finished(runId)).status).toBe("done");
    const events = await runs.allEvents(runId);
    expect(ofType(events, "step.finished")).toMatchObject([
      { step: 1, ok: false, output: "There's no @nobody in this room. Agents: @agent, @researcher." },
    ]);
    expect(ofType(events, "helper.started")).toEqual([]);
  });

  it("a helper's write waits for a member; the execution resumes from its checkpoints and runs each step once", async () => {
    const at = await room({ researcherTools: ["github"], github: true });
    const { thread, runId } = await leadRun(at, "ask:researcher call:github_comment");
    const waiting = await until("the helper's approval", async () => {
      const t = await threads.threadById(at.roomId, thread.threadId);
      return t?.status === "waiting" ? t : undefined;
    });
    expect(waiting.approval).toMatchObject({ step: 2 });
    await decideApproval(at.owner, runId, 2, "approve");
    expect((await finished(runId)).status).toBe("done");

    const events = await runs.allEvents(runId);
    expect(ofType(events, "approval.requested")).toMatchObject([{ lane: 1, step: 2 }]);
    expect(ofType(events, "approval.settled")).toMatchObject([{ lane: 1, step: 2, decision: "approved" }]);
    expect(ofType(events, "helper.started")).toHaveLength(1);
    expect(ofType(events, "step.finished").map((e) => [laneOf(e), e.step, e.ok])).toEqual([[1, 2, true], [0, 1, true]]);
    expect(ofType(events, "helper.finished")).toMatchObject([{ status: "done", steps: 1 }]);

    // The wake started a new invocation, which replayed everything before the wait: no step started twice.
    const started = await stepStarts(runId);
    expect(started).toEqual(expect.arrayContaining(["h1-model-1", "h1-gate-1-call-1", "h1-settle-1-call-1", "h1-tool-1-call-1"]));
    expect(started.filter((name, i) => started.indexOf(name) !== i)).toEqual([]);
  });
});
