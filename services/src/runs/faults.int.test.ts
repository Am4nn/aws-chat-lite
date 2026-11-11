import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { threadSk } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import { runsRepo, type Run } from "./repo.js";
import { startOrSteer } from "./start.js";
import { modelTurn, toolStep } from "./steps.js";

// Failures injected into this process's table calls, against DynamoDB on Floci (npm run deploy:local first). The run
// loop's step bodies are called directly: a durable retry runs the same body again with the same input, so calling
// one twice is a retry.
process.env.MODEL_GATEWAY = "fake";
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

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
async function runningThread(text: string) {
  const { owner, roomId, thread: t, message } = await thread(text);
  const run: Run = {
    runId: randomUUID(), roomId, threadId: t.threadId, number: t.number, status: "running", model: "fake", pick: "auto",
    pickBy: "default", startedBy: owner.username, startedAt: new Date().toISOString(), firstSeq: message.seq, seenSeq: message.seq, steps: 0,
    costMicros: 0,
  };
  await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RUN#${run.runId}`, sk: "META", ...run } }));
  await docClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(t.number) },
    UpdateExpression: "SET activeRunId = :r", ExpressionAttributeValues: { ":r": run.runId },
  }));
  return { owner, roomId, thread: t, run };
}

const call = { id: "call-1", name: "fake.lookup", input: { query: "go", slow: false } };
const count = async (runId: string, type: string) => (await runs.allEvents(runId)).filter((e) => e.type === type).length;
const activeRunOf = async (roomId: string, n: number) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(n) }, ConsistentRead: true }))).Item?.activeRunId;

describe("run steps and starts under injected failures", () => {
  it("a model turn retried after it logged a steer doesn't log the steer twice", async () => {
    const { owner, roomId, thread: t, run } = await runningThread("go tools:1");
    await chatRepo().send(owner, { roomId, chatId: t.threadId, clientId: `k${++clients}`, text: "and prod" });
    fail(puts("usage"));
    await expect(modelTurn(run)).rejects.toThrow("injected failure");
    expect(await modelTurn(run)).toMatchObject({ seenSeq: 2, toolCalls: [{ name: "fake.lookup" }] });
    expect(await count(run.runId, "steer")).toBe(1);
  });

  it("a tool step retried after it logged step.started doesn't log it twice", async () => {
    const { run } = await runningThread("go tools:1");
    fail(puts("step.finished"));
    await expect(toolStep(run, call)).rejects.toThrow("injected failure");
    expect(await toolStep(run, call)).toEqual({ steps: 1 });
    expect(await count(run.runId, "step.started")).toBe(1);
    expect(await count(run.runId, "step.finished")).toBe(1);
  });

  it("a tool step checks the run's limits first, so a turn with many tool calls can't pass 200 steps", async () => {
    const { run } = await runningThread("go tools:1");
    expect(await toolStep({ ...run, steps: 200 }, call)).toEqual({
      steps: 200, end: { status: "failed", reason: "Step limit reached (200 steps)." },
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

  it("a start that loses a transaction race once tries again and starts the run", async () => {
    const { owner, roomId, thread: t, message } = await thread("go tools:0 words:3");
    fail(claims, { error: conflict });
    const { runId, started } = await startOrSteer(owner, roomId, t.threadId, message);
    expect(started).toBe(true);
    expect(await activeRunOf(roomId, t.number)).toBe(runId);
  });

  it("a start that keeps losing the race is delivered as a steer, not an error", async () => {
    const { owner, roomId, thread: t, run } = await runningThread("go");
    const message = await chatRepo().send(owner, { roomId, chatId: t.threadId, clientId: `k${++clients}`, text: "more" });
    fail(claims, { times: 2, error: conflict });
    expect(await startOrSteer(owner, roomId, t.threadId, message)).toEqual({ runId: run.runId, started: false });
  });
});
