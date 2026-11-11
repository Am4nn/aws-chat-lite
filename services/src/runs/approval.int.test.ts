import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { decideApproval } from "../approvals/decide.js";
import { approvalsRepo } from "../approvals/repo.js";
import { auditRepo } from "../audit/repo.js";
import { docClient, tableName } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { recordGitHub } from "../tools/fake-github.js";
import { toolEnv } from "../tools/index.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEvent } from "../threads/types.js";
import { gateOf } from "./approval.js";
import { runsRepo, type Run } from "./repo.js";
import { startOrSteer } from "./start.js";
import { toolStep } from "./steps.js";
import { requestStop } from "./stop.js";

// Runs against the deployed run function on Floci, in fake model and tool modes: npm run deploy:local, then this file.
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";
process.env.MODEL_GATEWAY = "fake";

const runs = runsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COMMENT_TITLE = "Comment on #1 in fake-org/playground?";
let clients = 0;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const finished = (runId: string, ms?: number) =>
  until("the run to end", async () => {
    const run = await runs.getRun(runId);
    if (!run || run.status === "running") return undefined;
    return (await runs.allEvents(runId)).at(-1)?.type === "run.finished" ? run : undefined;
  }, ms);

const eventsOf = (runId: string, type: RunEvent["type"]) => runs.allEvents(runId).then((all) => all.filter((e) => e.type === type));

/** A room with aman as owner and bea as a member, its GitHub connection put in directly, and any room settings. */
async function room({ connected = true, approvalTimeoutSec }: { connected?: boolean; approvalTimeoutSec?: number } = {}) {
  const aman = user("aman");
  const bea = user("bea");
  const rooms = roomsRepo();
  const { roomId } = await rooms.createRoom(aman, "Approvals");
  await rooms.acceptInvite((await rooms.rotateInvite(roomId, aman.userId)).code, bea);
  const db = docClient();
  if (connected) {
    await db.send(new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `ROOM#${roomId}`, sk: "CONN#github", installationId: 1, account: "fake-org", repos: ["fake-org/playground"],
        addedBy: "aman", addedAt: new Date().toISOString(),
      },
    }));
  }
  if (approvalTimeoutSec) {
    await db.send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: "META" }, UpdateExpression: "SET approvalTimeoutSec = :s",
      ExpressionAttributeValues: { ":s": approvalTimeoutSec },
    }));
  }
  return { aman, bea, roomId };
}

async function startRun(text: string, at: Awaited<ReturnType<typeof room>>) {
  const { thread, message } = await threadsRepo().createThread(at.aman, at.roomId, { text, clientId: `k${++clients}` });
  const started = await startOrSteer(at.aman, at.roomId, thread.threadId, message);
  return { thread, ...started };
}

const waiting = (roomId: string, threadId: string) =>
  until("the thread to wait for approval", async () => {
    const thread = await threadsRepo().threadById(roomId, threadId);
    return thread?.status === "waiting" ? thread : undefined;
  });

describe("approvals in the run loop, on Floci", { timeout: 60_000 }, () => {
  it("a write waits for a member, runs the approved input once, taints the thread and is audited", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:github_comment", at);
    expect((await waiting(at.roomId, thread.threadId)).approval).toMatchObject({ step: 1, title: COMMENT_TITLE });

    expect(await decideApproval(at.bea, runId, 1, "approve")).toEqual({ status: "approved", by: "bea" });
    expect((await finished(runId)).status).toBe("done");

    const [requested] = await eventsOf(runId, "approval.requested");
    expect(await eventsOf(runId, "approval.settled")).toMatchObject([{ step: 1, decision: "approved", by: "bea" }]);
    const steps = await eventsOf(runId, "step.finished");
    expect(steps).toMatchObject([{ step: 1, ok: true }]);
    const [started] = await eventsOf(runId, "step.started");
    expect(started.type === "step.started" && started.call.input).toEqual(requested.type === "approval.requested" && requested.call.input);
    const after = await threadsRepo().threadById(at.roomId, thread.threadId);
    expect(after).toMatchObject({ status: "done", taint: ["github"] });
    expect(after).not.toHaveProperty("approval");
    const kinds = (await auditRepo().list(at.roomId)).entries.map((e) => e.kind);
    expect(kinds.sort()).toEqual(["approved", "asked", "tool"]);
  });

  it("of an approve and a deny at once, one wins, the other gets a 409, and the write runs at most once", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:github_comment", at);
    await waiting(at.roomId, thread.threadId);
    const results = await Promise.allSettled([
      decideApproval(at.aman, runId, 1, "approve"), decideApproval(at.bea, runId, 1, "deny"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
    expect((await finished(runId)).status).toBe("done");
    expect(await eventsOf(runId, "step.finished")).toHaveLength(1);
  });

  it("a denied write isn't run: the model is told who denied it and the run carries on", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:github_comment", at);
    await waiting(at.roomId, thread.threadId);
    await decideApproval(at.bea, runId, 1, "deny");
    expect((await finished(runId)).status).toBe("done");
    const [step] = await eventsOf(runId, "step.finished");
    expect(step).toMatchObject({ ok: false, output: expect.stringMatching(/^Denied by bea\./) });
    expect((await threadsRepo().threadById(at.roomId, thread.threadId))!.taint).toEqual([]);
  });

  it("no decision in time skips the write, notes it in the answer, and the wait is off the run's clock", async () => {
    const at = await room({ approvalTimeoutSec: 5 });
    const { runId } = await startRun("go call:github_comment", at);
    const run = await finished(runId, 40_000);
    expect(run.status).toBe("done");
    expect(await approvalsRepo().settle(runId, 1)).toMatchObject({ status: "expired" });
    const text = (await eventsOf(runId, "text")).map((e) => (e.type === "text" ? e.text : "")).join("");
    expect(text.endsWith(`\n\n(Skipped because no one approved in time: ${COMMENT_TITLE})`)).toBe(true);
    expect((run as Run & { pausedMs?: number }).pausedMs).toBeGreaterThanOrEqual(5000);
  });

  it("a stop while waiting ends the run within seconds and cancels the approval", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:github_comment", at);
    await waiting(at.roomId, thread.threadId);
    const stoppedAt = Date.now();
    await requestStop(at.bea, at.roomId, thread.threadId);
    expect((await finished(runId, 10_000)).status).toBe("stopped");
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(await approvalsRepo().settle(runId, 1)).toMatchObject({ status: "cancelled", by: "bea" });
  });

  it("reads need no approval: a search cites its sources, a GitHub read taints the thread", async () => {
    const at = await room();
    const search = await startRun("go call:web_search", at);
    expect((await finished(search.runId)).status).toBe("done");
    expect((await eventsOf(search.runId, "step.finished"))[0]).toMatchObject({ ok: true, sources: [{}, {}] });
    expect((await threadsRepo().threadById(at.roomId, search.thread.threadId))!.taint).toEqual([]);

    const read = await startRun("go call:github_read_file", at);
    expect((await finished(read.runId)).status).toBe("done");
    expect(await eventsOf(read.runId, "approval.requested")).toEqual([]);
    expect((await threadsRepo().threadById(at.roomId, read.thread.threadId))!.taint).toEqual(["github"]);
  });

  // These call the tool step directly, in this process, on a run that is stored but not executing.
  async function storedRun(at: Awaited<ReturnType<typeof room>>): Promise<Run & { model: string }> {
    const { thread, message } = await threadsRepo().createThread(at.aman, at.roomId, { text: "x", clientId: `k${++clients}` });
    const run: Run & { model: string } = {
      runId: randomUUID(), roomId: at.roomId, threadId: thread.threadId, number: thread.number, status: "running", model: "fake",
      pick: "auto", pickBy: "default", startedBy: "aman", startedAt: new Date().toISOString(),
      deadAt: new Date(Date.now() + 7_800_000).toISOString(), firstSeq: message.seq, seenSeq: message.seq, steps: 0, costMicros: 0,
    };
    await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RUN#${run.runId}`, sk: "META", ...run } }));
    return run;
  }

  it("a write step found already started is never run again: the model is told it may have happened", async () => {
    const at = await room();
    const run = await storedRun(at);
    const call = { id: "call-1", name: "github_comment", input: { number: 1, body: "fake" } };
    await (await runs.eventWriter(run.runId)).append({ type: "step.started", step: 1, call, detail: "Commenting on #1" });
    const github = recordGitHub();
    const approved = {
      runId: run.runId, roomId: at.roomId, threadId: run.threadId, step: 1, call, title: COMMENT_TITLE, callbackId: "cb",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), requestedAt: new Date().toISOString(), status: "approved" as const, by: "bea",
    };
    await toolStep(run, call, approved, async (mode, conn) => ({ ...await toolEnv(mode, conn), fetch: github.fetch }));
    const [step] = await eventsOf(run.runId, "step.finished");
    expect(step).toMatchObject({ ok: false, output: expect.stringMatching(/^This write may or may not have happened/) });
    expect(github.calls).toEqual([]);
  });

  it("a write to a repo outside the connection asks no one, and the tool refuses it", async () => {
    const at = await room();
    const run = await storedRun(at);
    const call = { id: "call-1", name: "github_comment", input: { repo: "other/x", number: 1, body: "b" } };
    expect(await gateOf(run, call)).toEqual({ write: false });
    await toolStep(run, call);
    const [step] = await eventsOf(run.runId, "step.finished");
    expect(step).toMatchObject({ ok: false, output: expect.stringMatching(/^other\/x isn't connected to this room\./) });
  });

  it("a GitHub call in a room with no connection is refused by the tool, before any approval", async () => {
    const at = await room({ connected: false });
    const run = await storedRun(at);
    await toolStep(run, { id: "call-1", name: "github_read_file", input: { path: "README.md" } });
    const [step] = await eventsOf(run.runId, "step.finished");
    expect(step).toMatchObject({ ok: false, output: expect.stringMatching(/^GitHub isn't connected to this room\./) });
    expect(await eventsOf(run.runId, "approval.requested")).toEqual([]);
  });
});
