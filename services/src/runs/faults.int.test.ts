import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { budgetRepo } from "../budget/repo.js";
import { seqKey } from "../chat/model.js";
import { threadSk } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import { runsRepo, type Run } from "./repo.js";
import { startOrSteer } from "./start.js";
import { answerOf } from "./context.js";
import { DEAD_AFTER_MS } from "./model.js";
import { failRun, modelTurn, nameThread, routeRun, toolStep } from "./steps.js";
import { dockerSandbox } from "../sandbox/docker.js";
import { startSandboxServer } from "../sandbox/server.js";
import { workspaceRepo } from "../workspace/repo.js";
import { closeSandbox } from "../workspace/session.js";
import { getBytes } from "../workspace/storage.js";

// Failures injected into this process's table calls, against DynamoDB on Floci (npm run deploy:local first). The run
// loop's step bodies are called directly: a durable retry runs the same body again with the same input, so calling
// one twice is a retry.
process.env.MODEL_GATEWAY = "fake";
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";
// Sandbox steps run in this process against the sandbox server on this machine, which needs Docker and the image.
Object.assign(process.env, {
  SANDBOX_KIND: "docker", SANDBOX_URL: "http://127.0.0.1:4700",
  SANDBOX_TOKEN: readFileSync(new URL("../../../.secrets/sandbox-token", import.meta.url), "utf8").trim(),
});
let sandboxServer: Server | undefined;
beforeAll(async () => {
  if (await fetch("http://127.0.0.1:4700/").then(() => true, () => false)) return;
  sandboxServer = startSandboxServer(dockerSandbox(), { token: process.env.SANDBOX_TOKEN! });
  await new Promise((resolve) => sandboxServer!.once("listening", resolve));
});
afterAll(() => new Promise<void>((resolve) => (sandboxServer ? sandboxServer.close(() => resolve()) : resolve())));

const runs = runsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
let clients = 0;

afterEach(() => vi.restoreAllMocks());

/** Makes the first `times` table calls that `match` picks fail with `error`, the way a crash or a race would. */
function fail(match: (command: unknown) => boolean, { times = 1, error = new Error("injected failure") } = {}) {
  const db = docClient();
  const send = db.send.bind(db) as (...args: unknown[]) => unknown;
  let left = times;
  vi.spyOn(db, "send").mockImplementation(((command: unknown, ...rest: unknown[]) => {
    if (left > 0 && match(command)) {
      left--;
      return Promise.reject(error);
    }
    return send(command, ...rest);
  }) as never);
}
const puts = (type: string) => (c: unknown) => c instanceof PutCommand && c.input.Item?.type === type;
/** The usage event's write, on its own or as the first item of a transaction. */
const usageWrite = (c: unknown) => puts("usage")(c) || (c instanceof TransactWriteCommand && c.input.TransactItems?.[0]?.Put?.Item?.type === "usage");
/** The run half of a progress write that carries the run's cost. */
const costProgress = (c: unknown) => c instanceof UpdateCommand && String(c.input.Key?.pk).startsWith("RUN#")
  && Object.values(c.input.ExpressionAttributeNames ?? {}).includes("costMicros");
/** The start transaction: it puts the new run's META first. */
const claims = (c: unknown) => c instanceof TransactWriteCommand && String(c.input.TransactItems?.[0]?.Put?.Item?.pk).startsWith("RUN#");
const conflict = Object.assign(new Error("Transaction cancelled"), {
  name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }],
});

async function thread(text: string) {
  const owner = user("owner");
  const { roomId } = await roomsRepo().createRoom(owner, "Faults");
  const created = await threadsRepo().createThread(owner, roomId, { text, clientId: `k${++clients}` });
  return { owner, roomId, ...created };
}

/** A thread with a running run, written straight to the table so no run function is invoked. */
async function runningThread(text: string, startedAt = new Date().toISOString()) {
  const { owner, roomId, thread: t, message } = await thread(text);
  const run = {
    runId: randomUUID(), roomId, threadId: t.threadId, number: t.number, status: "running", model: "fake", pick: "auto",
    pickBy: "default", startedBy: owner.username, startedAt, firstSeq: message.seq, seenSeq: message.seq, steps: 0,
    costMicros: 0,
  } satisfies Run;
  await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RUN#${run.runId}`, sk: "META", ...run } }));
  await docClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(t.number) },
    UpdateExpression: "SET activeRunId = :r, runId = :r, #status = :running, startedAt = :at",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":r": run.runId, ":running": "running", ":at": startedAt },
  }));
  return { owner, roomId, thread: t, run };
}

/** Takes the thread chat's next `n` seqs without writing their messages, as sends still in flight would. */
const takeSeqs = (threadId: string, n: number) => docClient().send(new UpdateCommand({
  TableName: tableName(), Key: { pk: `CHAT#${threadId}`, sk: "META" }, UpdateExpression: "ADD lastSeq :n", ExpressionAttributeValues: { ":n": n },
}));
/** Writes the message for a seq taken earlier. */
const putMessage = (roomId: string, threadId: string, seq: number, text: string) => docClient().send(new PutCommand({
  TableName: tableName(), Item: {
    pk: `CHAT#${threadId}`, sk: seqKey(seq), roomId, chatId: threadId, seq, authorId: "u", authorName: "ravi", text,
    createdAt: new Date().toISOString(), attachments: [], mentions: [], everyone: false,
  },
}));
const spent = async (roomId: string) => (await budgetRepo().get(roomId, new Date())).spentMicros;
const answers = (text: string) => text.match(/Fake answer for/g)?.length ?? 0;
const steerTexts = async (runId: string) => (await runs.allEvents(runId)).flatMap((e) => (e.type === "steer" ? [e.text] : []));

const call = { id: "call-1", name: "fake.lookup", input: { query: "go", slow: false } };
const count = async (runId: string, type: string) => (await runs.allEvents(runId)).filter((e) => e.type === type).length;
const activeRunOf = async (roomId: string, n: number) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(n) }, ConsistentRead: true }))).Item?.activeRunId;

describe("run steps and starts under injected failures", () => {
  it("a model turn retried after it logged a steer doesn't log the steer twice", async () => {
    const { owner, roomId, thread: t, run } = await runningThread("go tools:1");
    await chatRepo().send(owner, { roomId, chatId: t.threadId, clientId: `k${++clients}`, text: "and prod" });
    fail(usageWrite);
    await expect(modelTurn(run, 1)).rejects.toThrow("injected failure");
    expect(await modelTurn(run, 1)).toMatchObject({ seenSeq: 2, toolCalls: [{ name: "fake.lookup" }] });
    expect(await count(run.runId, "steer")).toBe(1);
  });

  it("a steer's files are named on its steer event, so the model hears of them", async () => {
    const { owner, roomId, thread: t, run } = await runningThread("go tools:1");
    const file = { key: `rooms/${roomId}/u/f/log.txt`, name: "log.txt", size: 1, type: "text/plain" };
    await chatRepo().send(owner, { roomId, chatId: t.threadId, clientId: `k${++clients}`, text: "and this" }, { text: "and this", attachments: [file] });
    await modelTurn(run, 1);
    const steers = (await runs.allEvents(run.runId)).filter((e) => e.type === "steer");
    expect(steers).toEqual([expect.objectContaining({ text: "and this", attachments: ["log.txt"] })]);
  });

  it("a model turn that fails after streaming, before its usage is recorded, answers once and charges once", async () => {
    const { roomId, run } = await runningThread("go tools:0 words:5");
    fail(usageWrite);
    await expect(modelTurn(run, 1)).rejects.toThrow("injected failure");
    const turn = await modelTurn(run, 1);
    const events = await runs.allEvents(run.runId);
    expect(events.filter((e) => e.type === "text.reset")).toEqual([expect.objectContaining({ turn: 1 })]);
    expect(answers(answerOf(events).text)).toBe(1);
    expect(answerOf(events).text).toMatch(/^Fake answer for/);
    expect(await count(run.runId, "usage")).toBe(1);
    expect(await spent(roomId)).toBe(turn.costMicros);
  });

  it("a model turn that fails after its usage is recorded returns that turn on retry, without calling the model again", async () => {
    const { roomId, run } = await runningThread("go tools:0 words:5");
    fail(costProgress);
    await expect(modelTurn(run, 1)).rejects.toThrow("injected failure");
    const written = await count(run.runId, "text");
    const turn = await modelTurn(run, 1);
    expect(turn).toMatchObject({ toolCalls: [], seenSeq: 1 });
    expect(await count(run.runId, "text")).toBe(written);
    expect(await count(run.runId, "usage")).toBe(1);
    expect(await spent(roomId)).toBe(turn.costMicros);
  });

  it("a model turn whose text can't be logged charges that call, then answers once on retry, its cost counting both calls", async () => {
    const { roomId, run } = await runningThread("go tools:0 words:5");
    fail(puts("text"));
    await expect(modelTurn(run, 1)).rejects.toThrow("injected failure");
    const turn = await modelTurn(run, 1);
    const events = await runs.allEvents(run.runId);
    expect(answers(answerOf(events).text)).toBe(1);
    expect(await count(run.runId, "usage")).toBe(2);
    expect(await spent(roomId)).toBe(turn.costMicros);
  });

  it("a call that drops before any text is billed, then tried again, its cost counting both calls", async () => {
    const { roomId, run } = await runningThread("go tools:0 drop:0");
    await expect(modelTurn(run, 1)).rejects.toThrow("fake connection dropped");
    expect(await count(run.runId, "usage")).toBe(1);
    expect(await spent(roomId)).toBeGreaterThan(0);
    // The connection comes back: the retried call reads the same first message, minus the drop.
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `CHAT#${run.threadId}`, sk: seqKey(run.firstSeq) },
      UpdateExpression: "SET #text = :t", ExpressionAttributeNames: { "#text": "text" }, ExpressionAttributeValues: { ":t": "go tools:0 words:3" },
    }));
    const turn = await modelTurn(run, 1);
    expect(turn.end).toBeUndefined();
    expect(answers(answerOf(await runs.allEvents(run.runId)).text)).toBe(1);
    expect(await count(run.runId, "usage")).toBe(2);
    expect(await spent(roomId)).toBe(turn.costMicros);
  });

  it("a call that drops after its text is billed once and ends the run failed, and a retry doesn't call again", async () => {
    const { roomId, run } = await runningThread("go tools:0 drop:5 words:20");
    const turn = await modelTurn(run, 1);
    expect(turn.end).toEqual({ status: "failed", reason: "The model's connection dropped mid-answer." });
    expect(turn.costMicros).toBeGreaterThan(0);
    expect(await modelTurn(run, 1)).toEqual(turn);
    expect(await count(run.runId, "usage")).toBe(1);
    expect(await spent(roomId)).toBe(turn.costMicros);
  });

  it.each([
    ["its native turn", "go tools:1", "model.turn"],
    ["the length note", "look cutoff", "text"],
  ])("a model turn whose %s can't be logged charges that call, then charges the retry once", async (_what, text, type) => {
    const { roomId, run } = await runningThread(text);
    fail(puts(type));
    await expect(modelTurn(run, 1)).rejects.toThrow("injected failure");
    expect(await count(run.runId, "usage")).toBe(1);
    const turn = await modelTurn(run, 1);
    expect(await count(run.runId, "usage")).toBe(2);
    expect(await spent(roomId)).toBe(turn.costMicros);
  });

  it("a run that fails closes with the cost its usage events add up to, even when the stored total lags", async () => {
    const { roomId, run } = await runningThread("go tools:0 words:5");
    fail(costProgress);
    await expect(modelTurn(run, 1)).rejects.toThrow("injected failure");
    expect((await runs.getRun(run.runId))!.costMicros).toBe(0);
    await failRun(run.runId);
    expect(await runs.getRun(run.runId)).toMatchObject({ status: "failed", costMicros: await spent(roomId) });
    expect(await spent(roomId)).toBeGreaterThan(0);
  });

  it("a tool turn retried after its usage failed to record voids the first attempt's native turn", async () => {
    const { run } = await runningThread("go tools:1");
    fail(usageWrite);
    await expect(modelTurn(run, 1)).rejects.toThrow("injected failure");
    expect(await modelTurn(run, 1)).toMatchObject({ toolCalls: [{ name: "fake.lookup" }] });
    const types = (await runs.allEvents(run.runId)).map((e) => e.type).filter((t) => t !== "steer");
    expect(types).toEqual(["model.turn", "text.reset", "model.turn", "usage"]);
  });

  it("routing retried after the router's usage is recorded asks the router once and logs routed once", async () => {
    const { roomId, run } = await runningThread("route:haiku hi");
    fail(puts("routed"));
    await expect(routeRun(run)).rejects.toThrow("injected failure");
    const routed = await routeRun(run);
    expect(routed).toMatchObject({ model: "claude-haiku-5-5" });
    expect(await count(run.runId, "usage")).toBe(1);
    expect(await count(run.runId, "routed")).toBe(1);
    expect(await spent(roomId)).toBe(routed.costMicros);
  });

  it("naming retried after its usage is recorded charges once and still names the thread", async () => {
    const { roomId, thread: t, run } = await runningThread("summarise the logs");
    fail((c) => c instanceof TransactWriteCommand && !!c.input.TransactItems?.[0]?.Delete);
    await expect(nameThread(run)).rejects.toThrow("injected failure");
    const cost = await nameThread(run);
    expect(cost).toBeGreaterThan(0);
    expect(await spent(roomId)).toBe(cost);
    expect((await threadsRepo().threadById(roomId, t.threadId))?.name).toBe("summarise-the-logs");
  });

  it("a message whose put lands after a later one's is still read, in order, before the cursor passes it", async () => {
    const { roomId, thread: t, run } = await runningThread("go tools:1");
    await takeSeqs(t.threadId, 2);
    await putMessage(roomId, t.threadId, 3, "second");
    setTimeout(() => void putMessage(roomId, t.threadId, 2, "first"), 300);
    expect(await modelTurn(run, 1)).toMatchObject({ seenSeq: 3 });
    expect(await steerTexts(run.runId)).toEqual(["first", "second"]);
  });

  it("a seq that never fills is stepped over with a warning, and the message after it is still read", async () => {
    const { roomId, thread: t, run } = await runningThread("go tools:1");
    await takeSeqs(t.threadId, 2);
    await putMessage(roomId, t.threadId, 3, "after the hole");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await modelTurn(run, 1)).toMatchObject({ seenSeq: 3 });
    expect(await steerTexts(run.runId)).toEqual(["after the hole"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("never written"), t.threadId, 2);
  });

  it("a tool step retried after it logged step.started doesn't log it twice", async () => {
    const { run } = await runningThread("go tools:1");
    fail(puts("step.finished"));
    await expect(toolStep(run, call)).rejects.toThrow("injected failure");
    expect(await toolStep(run, call)).toEqual({ steps: 1, costMicros: run.costMicros });
    expect(await count(run.runId, "step.started")).toBe(1);
    expect(await count(run.runId, "step.finished")).toBe(1);
  });

  it("a sandbox step that fails after its code ran saves the files on retry without running the code again", async () => {
    const { run } = await runningThread("go");
    const append = { id: "call-1", name: "sandbox_run", input: { language: "shell", code: "echo x >> log.txt" } };
    // The room usage read comes after the code ran, while its changes are being saved.
    fail((c) => c instanceof GetCommand && c.input.ProjectionExpression === "filesBytes, filesCount");
    try {
      await expect(toolStep(run, append)).rejects.toThrow("injected failure");
      expect(await toolStep(run, append)).toMatchObject({ steps: 1 });
      const file = await workspaceRepo().get(run.roomId, "log.txt");
      expect(new TextDecoder().decode(await getBytes(file!.objectKey))).toBe("x\n");
      expect(await count(run.runId, "step.finished")).toBe(1);
      expect((await runs.allEvents(run.runId)).filter((e) => e.type === "usage" && e.job === "sandbox")).toHaveLength(1);
    } finally {
      await closeSandbox(run.runId);
    }
  }, 60_000);

  it("a tool step checks the run's limits first, so a turn with many tool calls can't pass 200 steps", async () => {
    const { run } = await runningThread("go tools:1");
    expect(await toolStep({ ...run, steps: 200 }, call)).toEqual({
      steps: 200, costMicros: run.costMicros, end: { status: "failed", reason: "Step limit reached (200 steps)." },
    });
    expect(await count(run.runId, "step.started")).toBe(0);
  });

  it("a start whose run.started can't be written fails the run and frees the thread", async () => {
    const { owner, roomId, thread: t, message } = await thread("go");
    fail(puts("run.started"));
    const { runId, started } = await startOrSteer(owner, roomId, t.threadId, message);
    expect(started).toBe(true);
    expect(await runs.getRun(runId)).toMatchObject({ status: "failed", reason: "The run couldn't start." });
    expect(await activeRunOf(roomId, t.number)).toBeUndefined();
  });

  it("a start reads the room default with a consistent read, so a default set a moment ago applies", async () => {
    const { owner, roomId, thread: t, message } = await thread("go tools:0 words:3");
    const send = vi.spyOn(docClient(), "send");
    await startOrSteer(owner, roomId, t.threadId, message);
    const reads = send.mock.calls.map(([c]) => c)
      .filter((c) => c instanceof GetCommand && c.input.Key?.pk === `ROOM#${roomId}` && Object.values(c.input.ExpressionAttributeNames ?? {}).includes("defaultModel"));
    expect(reads.map((c) => (c as GetCommand).input.ConsistentRead)).toEqual([true]);
  });

  it("a start that loses a transaction race once tries again and starts the run", async () => {
    const { owner, roomId, thread: t, message } = await thread("go tools:0 words:3");
    fail(claims, { error: conflict });
    const { runId, started } = await startOrSteer(owner, roomId, t.threadId, message);
    expect(started).toBe(true);
    expect(await activeRunOf(roomId, t.number)).toBe(runId);
  });

  it("a start that clashes twice with no run active keeps trying and starts the run", async () => {
    const { owner, roomId, thread: t, message } = await thread("go tools:0 words:3");
    fail(claims, { times: 2, error: conflict });
    const { runId, started } = await startOrSteer(owner, roomId, t.threadId, message);
    expect(started).toBe(true);
    expect(await activeRunOf(roomId, t.number)).toBe(runId);
  });

  it("a start that replaces a dead run marks that run failed", async () => {
    const dead = new Date(Date.now() - DEAD_AFTER_MS - 60_000).toISOString();
    const { owner, roomId, thread: t, run } = await runningThread("go", dead);
    const message = await chatRepo().send(owner, { roomId, chatId: t.threadId, clientId: `k${++clients}`, text: "again tools:0 words:3" });
    const { runId, started } = await startOrSteer(owner, roomId, t.threadId, message);
    expect(started).toBe(true);
    expect(runId).not.toBe(run.runId);
    expect(await runs.getRun(run.runId)).toMatchObject({ status: "failed", reason: "The run stopped responding." });
    expect(await activeRunOf(roomId, t.number)).toBe(runId);
  });

  it("a start that keeps losing the race is delivered as a steer, not an error", async () => {
    const { owner, roomId, thread: t, run } = await runningThread("go");
    const message = await chatRepo().send(owner, { roomId, chatId: t.threadId, clientId: `k${++clients}`, text: "more" });
    fail(claims, { times: 2, error: conflict });
    expect(await startOrSteer(owner, roomId, t.threadId, message)).toEqual({ runId: run.runId, started: false });
  });
});
