import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { decideApproval } from "../approvals/decide.js";
import { approvalsRepo } from "../approvals/repo.js";
import { agentsRepo } from "../agents/repo.js";
import { auditRepo } from "../audit/repo.js";
import { chatRepo } from "../chat/repo.js";
import { connectionsRepo } from "../connections/repo.js";
import { docClient, tableName } from "../lib/db.js";
import { Conflict, Gone } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { recordGitHub } from "../tools/fake-github.js";
import { toolEnv } from "../tools/index.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEvent } from "../threads/types.js";
import { gateOf } from "./approval.js";
import { finishRun } from "./finish.js";
import { DEAD_AFTER_MS } from "./model.js";
import { BUILT_IN } from "../agents/model.js";
import { runsRepo, type Run } from "./repo.js";
import { startOrSteer } from "./start.js";
import type { RoutedRun } from "./steps.js";
import { toolStep } from "./tool-step.js";
import { endWaitingRuns, requestStop } from "./stop.js";

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
        pk: `ROOM#${roomId}`, sk: "LINK#github", installationId: 1, account: "fake-org", repos: ["fake-org/playground"],
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
    expect(requested.type === "approval.requested" && requested.call.input).toMatchObject({ repo: "fake-org/playground" });
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
    // Once the wait is over, the run's dead time is its own clock again, not the approval's expiry plus a margin.
    const ended = (await runs.getRun(runId))!;
    expect(Date.parse(ended.deadAt) - Date.parse(ended.startedAt) - (ended.pausedMs ?? 0)).toBe(DEAD_AFTER_MS);
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

  it("archiving the room refuses the decision and ends the waiting run at once, its approval cancelled", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:github_comment", at);
    await waiting(at.roomId, thread.threadId);
    await roomsRepo().archiveRoom(at.roomId, at.aman.userId);
    const archivedAt = Date.now();
    await endWaitingRuns(at.roomId);
    await expect(decideApproval(at.bea, runId, 1, "approve")).rejects.toEqual(new Gone("This room is archived."));
    expect(await finished(runId, 10_000)).toMatchObject({ status: "stopped", reason: "The room was archived." });
    expect(Date.now() - archivedAt).toBeLessThan(5_000);
    expect(await approvalsRepo().settle(runId, 1)).toMatchObject({ status: "cancelled" });
    expect(await eventsOf(runId, "step.finished")).toEqual([]);
  });

  it("an image in a private thread waits for a member, and is made once approved", async () => {
    const at = await room();
    const { thread, message } = await threadsRepo().createThread(at.aman, at.roomId, { text: "go call:image_generate", clientId: `k${++clients}` });
    await threadsRepo().addTaint(at.roomId, thread.number, ["attachment"]);
    const { runId } = await startOrSteer(at.aman, at.roomId, thread.threadId, message);
    expect((await waiting(at.roomId, thread.threadId)).approval?.title).toMatch(/^Send ".*" to Gemini for an image\?$/);
    await decideApproval(at.bea, runId, 1, "approve");
    expect((await finished(runId)).status).toBe("done");
    expect(await eventsOf(runId, "step.finished")).toMatchObject([{ step: 1, ok: true, image: { aspect: "1:1" } }]);
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

  it("a stop still wakes a run whose approval was decided but whose wake was lost", async () => {
    const at = await room();
    const { thread, runId } = await startRun("go call:github_comment", at);
    await waiting(at.roomId, thread.threadId);
    await decideApproval(at.bea, runId, 1, "approve", async () => {});
    const stoppedAt = Date.now();
    await requestStop(at.aman, at.roomId, thread.threadId);
    expect((await finished(runId, 10_000)).status).toBe("stopped");
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
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
  async function storedRun(at: Awaited<ReturnType<typeof room>>): Promise<RoutedRun> {
    const { thread, message } = await threadsRepo().createThread(at.aman, at.roomId, { text: "x", clientId: `k${++clients}` });
    const run: Run & { model: string } = {
      runId: randomUUID(), roomId: at.roomId, threadId: thread.threadId, number: thread.number, agentId: "agent", status: "running", model: "fake",
      pick: "auto", pickBy: "default", startedBy: "aman", startedById: at.aman.userId, startedAt: new Date().toISOString(),
      deadAt: new Date(Date.now() + 7_800_000).toISOString(), firstSeq: message.seq, seenSeq: message.seq, steps: 0, costMicros: 0,
    };
    await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RUN#${run.runId}`, sk: "META", ...run } }));
    return { ...run, agent: BUILT_IN, others: [] };
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
    expect(await gateOf(run, call, [])).toEqual({ asks: false });
    await toolStep(run, call);
    const [step] = await eventsOf(run.runId, "step.finished");
    expect(step).toMatchObject({ ok: false, output: expect.stringMatching(/^other\/x isn't connected to this room\./) });
  });

  it("a write runs on the repo its approval named, so a connection changed during the wait refuses it", async () => {
    const at = await room();
    const run = await storedRun(at);
    const call = { id: "call-1", name: "github_comment", input: { number: 1, body: "b" } };
    const gate = await gateOf(run, call, []);
    expect(gate).toMatchObject({ asks: true, title: COMMENT_TITLE, input: { number: 1, body: "b", repo: "fake-org/playground" } });
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${at.roomId}`, sk: "LINK#github" }, UpdateExpression: "SET repos = :r",
      ExpressionAttributeValues: { ":r": ["fake-org/other"] },
    }));
    const github = recordGitHub();
    const approved = {
      runId: run.runId, roomId: at.roomId, threadId: run.threadId, step: 1, call: { ...call, input: gate.asks ? gate.input : {} },
      title: COMMENT_TITLE, callbackId: "cb", expiresAt: new Date(Date.now() + 60_000).toISOString(), requestedAt: new Date().toISOString(),
      status: "approved" as const, by: "bea",
    };
    await toolStep(run, call, approved, async (mode, conn) => ({ ...await toolEnv(mode, conn), fetch: github.fetch }));
    const [step] = await eventsOf(run.runId, "step.finished");
    expect(step).toMatchObject({ ok: false, output: "fake-org/playground isn't connected to this room. Connected: fake-org/other." });
    expect(github.calls).toEqual([]);
  });

  it("web calls are free in a thread without private content and wait for a member in one with it", async () => {
    const at = await room();
    const run = await storedRun(at);
    const fetchCall = { id: "call-1", name: "web_fetch", input: { url: "https://example.com/?d=secret" } };
    const searchCall = { id: "call-2", name: "web_search", input: { query: "acme payroll" } };
    expect(await gateOf(run, fetchCall, [])).toEqual({ asks: false });
    // The turn saw private content the thread doesn't show yet.
    expect(await gateOf(run, searchCall, ["attachment"])).toMatchObject({ asks: true, title: 'Search the web for "acme payroll"?' });
    await threadsRepo().addTaint(at.roomId, run.number, ["github"]);
    expect(await gateOf(run, fetchCall, [])).toMatchObject({
      asks: true, title: "Fetch https://example.com/?d=secret?", input: fetchCall.input,
    });

    const denied = {
      runId: run.runId, roomId: at.roomId, threadId: run.threadId, step: 1, call: fetchCall, title: "Fetch https://example.com/?d=secret?",
      callbackId: "cb", expiresAt: new Date(Date.now() + 60_000).toISOString(), requestedAt: new Date().toISOString(),
      status: "denied" as const, by: "bea",
    };
    const fetched: string[] = [];
    await toolStep(run, fetchCall, denied, async (mode, conn) => ({
      ...await toolEnv(mode, conn), fetchPage: async (url) => { fetched.push(url); throw new Error("fetched"); },
    }));
    const [step] = await eventsOf(run.runId, "step.finished");
    expect(step).toMatchObject({ ok: false, output: expect.stringMatching(/^Denied by bea./) });
    expect(fetched).toEqual([]);
  });

  it("in Bypass a GitHub write runs at once, and after a room read a web search still waits for a member", async () => {
    const at = await room();
    await connectionsRepo().setApprovalMode(at.aman, at.roomId, "bypass");
    const write = await startRun("go call:github_comment", at);
    expect((await finished(write.runId)).status).toBe("done");
    expect(await eventsOf(write.runId, "approval.requested")).toEqual([]);
    expect(await eventsOf(write.runId, "step.finished")).toMatchObject([{ step: 1, ok: true }]);

    const run = await storedRun(at);
    const searchCall = { id: "call-1", name: "web_search", input: { query: "acme payroll" } };
    expect(await gateOf(run, searchCall, [])).toEqual({ asks: false });
    await threadsRepo().addTaint(at.roomId, run.number, ["room"]);
    expect(await gateOf(run, searchCall, [])).toMatchObject({ asks: true, title: 'Search the web for "acme payroll"?' });
  });

  it("in Ask a post waits for a member, in Auto it posts at once, and the channel gets it as the agent's", async () => {
    const at = await room({ connected: false });
    const { chatId } = await roomsRepo().createChat(at.roomId, at.aman.userId, "fake");
    const herald = await agentsRepo().create(at.aman, at.roomId, { name: "herald", instructions: "Post updates.", tools: ["room_post"], model: "room" });
    const post = async () => {
      const { thread, message } = await threadsRepo().createThread(at.aman, at.roomId, {
        text: "go call:room_post", clientId: `k${++clients}`, agentId: herald.agentId,
      });
      return { thread, ...await startOrSteer(at.aman, at.roomId, thread.threadId, message) };
    };

    const asked = await post();
    expect((await waiting(at.roomId, asked.thread.threadId)).approval?.title).toBe('Post in #fake: "fake"?');
    await decideApproval(at.bea, asked.runId, 1, "approve");
    expect((await finished(asked.runId)).status).toBe("done");

    await connectionsRepo().setApprovalMode(at.aman, at.roomId, "auto");
    const auto = await post();
    expect((await finished(auto.runId)).status).toBe("done");
    expect(await eventsOf(auto.runId, "approval.requested")).toEqual([]);

    const postOf = ({ thread }: typeof asked) => ({
      authorId: "agent", authorName: "herald", text: "fake", agentPost: { threadId: thread.threadId, number: thread.number },
    });
    expect((await chatRepo().history(at.aman, at.roomId, chatId, {})).messages).toMatchObject([postOf(asked), postOf(auto)]);
  });

  it("a skip note is logged only by the close that ends the run, so it never lands mid-answer", async () => {
    const at = await room();
    const run = await storedRun(at);
    const writer = await runs.eventWriter(run.runId);
    await writer.append({ type: "text", text: "Working on it.", turn: 1 });
    const call = { id: "call-1", name: "github_comment", input: { number: 1, body: "b" } };
    await writer.append({ type: "approval.requested", step: 1, call, title: COMMENT_TITLE, expiresAt: new Date().toISOString() });
    await writer.append({ type: "approval.settled", step: 1, decision: "expired" });
    // A member writes after the run's last read, so a close that isn't forced comes back "unread".
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `CHAT#${run.threadId}`, sk: "META" }, UpdateExpression: "ADD lastSeq :one",
      ExpressionAttributeValues: { ":one": 1 },
    }));
    expect(await finishRun(run, { status: "done" }, { seenSeq: run.seenSeq, force: false })).toBe("unread");
    expect((await eventsOf(run.runId, "text")).map((e) => e.type === "text" && e.text)).toEqual(["Working on it."]);

    expect(await finishRun(run, { status: "done" }, { seenSeq: run.seenSeq, force: true })).toBe("closed");
    const note = `

(Skipped because no one approved in time: ${COMMENT_TITLE})`;
    expect((await eventsOf(run.runId, "text")).map((e) => e.type === "text" && e.text)).toEqual(["Working on it.", note]);
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
