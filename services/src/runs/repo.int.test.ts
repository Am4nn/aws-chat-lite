import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { threadSk } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import { finishRun } from "./finish.js";
import { runsRepo, type Run } from "./repo.js";
import { startOrSteer } from "./start.js";
import { requestStop } from "./stop.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

const runs = runsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
let clients = 0;

const get = async (pk: string, sk: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk, sk }, ConsistentRead: true }))).Item;

/** A thread whose first message started a run, written straight to the table so no run function is invoked. */
async function runningThread(startedAt = new Date().toISOString()) {
  const owner = user("owner");
  const { roomId } = await roomsRepo().createRoom(owner, "Runs");
  const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go", clientId: `k${++clients}` });
  const run: Run = {
    runId: randomUUID(), roomId, threadId: thread.threadId, number: thread.number, status: "running", model: "fake",
    pick: "auto", pickBy: "default", startedBy: owner.username, startedAt, deadAt: new Date(Date.parse(startedAt) + 7_800_000).toISOString(),
    firstSeq: message.seq, seenSeq: message.seq, steps: 0, costMicros: 0,
  };
  await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RUN#${run.runId}`, sk: "META", ...run } }));
  await docClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(thread.number) },
    UpdateExpression: "SET activeRunId = :r, runId = :r, #status = :running, startedAt = :at, deadAt = :dead",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":r": run.runId, ":running": "running", ":at": startedAt, ":dead": run.deadAt },
  }));
  return { owner, roomId, thread, run };
}

const threadItem = (roomId: string, n: number) => get(`ROOM#${roomId}`, threadSk(n));

describe("runs repo on Floci", () => {
  it("an event writer carries on after the newest stored event", async () => {
    const runId = randomUUID();
    const first = await runs.eventWriter(runId);
    for (const text of ["a", "b", "c"]) await first.append({ type: "text", text });
    const second = await runs.eventWriter(runId);
    expect(await second.append({ type: "text", text: "d" })).toMatchObject({ seq: 4, type: "text", text: "d" });
    await second.append({ type: "text", text: "e" });
    const stored = await runs.events(runId, 0);
    expect(stored.map((e) => [e.seq, e.type === "text" && e.text])).toEqual([[1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]]);
    expect((await runs.events(runId, 3)).map((e) => e.seq)).toEqual([4, 5]);
  });

  it("appends made without awaiting each one still land in order", async () => {
    const runId = randomUUID();
    const writer = await runs.eventWriter(runId);
    await Promise.all(["a", "b", "c"].map((text) => writer.append({ type: "text", text })));
    expect((await runs.events(runId, 0)).map((e) => e.type === "text" && e.text)).toEqual(["a", "b", "c"]);
  });

  it("closeRun: a message past seenSeq keeps the run open, then the close posts one answer, once", async () => {
    const { owner, roomId, thread, run } = await runningThread();
    await chatRepo().send(owner, { roomId, chatId: thread.threadId, clientId: `k${++clients}`, text: "one more thing" });

    const close = (seenSeq: number) =>
      runs.closeRun(run, { status: "done", text: "Fake answer.\n\nbody", summary: "Fake answer.", seenSeq, force: false });
    expect(await close(1)).toEqual({ result: "unread" });
    expect(await threadItem(roomId, thread.number)).toMatchObject({ activeRunId: run.runId, status: "running" });

    const closed = await close(2);
    expect(closed).toMatchObject({ result: "closed", answer: { seq: 3, authorId: "agent", text: "Fake answer.\n\nbody" } });
    const { messages } = await chatRepo().history(owner, roomId, thread.threadId, {});
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages[2]).toMatchObject({
      authorId: "agent", authorName: "agent", text: "Fake answer.\n\nbody",
      agent: { runId: run.runId, status: "done", steps: 0, costMicros: 0, model: "fake", pick: "auto", firstSeq: 1 },
    });
    const item = await threadItem(roomId, thread.number);
    expect(item).toMatchObject({ status: "done", summary: "Fake answer.", rev: thread.rev + 1 });
    expect(item?.activeRunId).toBeUndefined();
    expect(await runs.getRun(run.runId)).toMatchObject({ status: "done", answerSeq: 3 });

    // A repeated close hands back the stored answer, so its caller can still announce it.
    expect(await close(3)).toEqual({ result: "already", answer: closed.answer });
    expect((await chatRepo().history(owner, roomId, thread.threadId, {})).messages.filter((m) => m.authorId === "agent")).toHaveLength(1);
  });

  it("a forced close lands past messages it has not read", async () => {
    const { owner, roomId, thread, run } = await runningThread();
    await chatRepo().send(owner, { roomId, chatId: thread.threadId, clientId: `k${++clients}`, text: "late" });
    const stopped = { status: "stopped" as const, reason: "Stopped by owner.", text: "", summary: "Stopped by owner.", seenSeq: 1, force: true };
    expect((await runs.closeRun(run, stopped)).result).toBe("closed");
    const { messages } = await chatRepo().history(owner, roomId, thread.threadId, {});
    expect(messages.at(-1)).toMatchObject({ seq: 3, authorId: "agent", agent: { status: "stopped", reason: "Stopped by owner." } });
    expect(await threadItem(roomId, thread.number)).toMatchObject({ status: "stopped", summary: "Stopped by owner." });
  });

  it("unread and prior read the thread around the run's cursor", async () => {
    const { owner, roomId, thread } = await runningThread();
    for (const text of ["two", "three"]) {
      await chatRepo().send(owner, { roomId, chatId: thread.threadId, clientId: `k${++clients}`, text });
    }
    expect((await runs.unread(thread.threadId, 1)).map((m) => m.text)).toEqual(["two", "three"]);
    expect((await runs.prior(thread.threadId, 2)).map((m) => m.text)).toEqual(["go", "two"]);
    expect(await runs.chatLastSeq(thread.threadId)).toBe(3);
  });

  it("progress writes the run and the thread, and bumps the thread's rev", async () => {
    const { roomId, thread, run } = await runningThread();
    const before = Number((await threadItem(roomId, thread.number))!.rev);
    const summary = await runs.progress(run, { steps: 2, currentStep: "fake.lookup", costMicros: 120 });
    expect(summary).toMatchObject({ steps: 2, currentStep: "fake.lookup", costMicros: 120, rev: before + 1, status: "running" });
    expect(await runs.getRun(run.runId)).toMatchObject({ steps: 2, costMicros: 120 });
  });

  it("requestStop: any member flags the running run; an idle thread has nothing to stop", async () => {
    const { owner, roomId, thread, run } = await runningThread();
    expect(await requestStop(owner, roomId, thread.threadId)).toEqual({ runId: run.runId });
    expect(await runs.getRun(run.runId)).toMatchObject({ stopRequestedBy: "owner" });

    const idle = await threadsRepo().createThread(owner, roomId, { text: "idle", clientId: `k${++clients}` });
    await expect(requestStop(owner, roomId, idle.thread.threadId)).rejects.toThrow(new Conflict("Nothing is running."));
  });

  it("requestStop on a run older than 130 minutes closes it as failed, which frees the thread", async () => {
    const { owner, roomId, thread, run } = await runningThread(new Date(Date.now() - 131 * 60_000).toISOString());
    expect(await requestStop(owner, roomId, thread.threadId)).toEqual({ runId: run.runId });
    expect(await runs.getRun(run.runId)).toMatchObject({ status: "failed", reason: "The run stopped responding." });
    expect((await threadItem(roomId, thread.number))?.activeRunId).toBeUndefined();
    expect((await runs.allEvents(run.runId)).at(-1)).toMatchObject({ type: "run.finished", status: "failed" });
  });

  it("finishing a run that is already closed keeps how it really ended", async () => {
    const { run } = await runningThread();
    expect(await finishRun(run, { status: "done" }, { seenSeq: 1, force: false })).toBe("closed");
    expect(await finishRun(run, { status: "failed", reason: "The agent hit an error." }, { seenSeq: 1, force: true })).toBe("already");
    expect((await runs.allEvents(run.runId)).filter((e) => e.type === "run.finished")).toEqual([expect.objectContaining({ status: "done" })]);
  });

  it("a run closed before its run.finished was written gets the event with its stored status", async () => {
    const { run } = await runningThread();
    expect((await runs.closeRun(run, { status: "done", text: "", summary: "", seenSeq: 1, force: false })).result).toBe("closed");
    expect(await finishRun(run, { status: "failed", reason: "The agent hit an error." }, { seenSeq: 1, force: true })).toBe("already");
    expect((await runs.allEvents(run.runId)).at(-1)).toMatchObject({ type: "run.finished", status: "done" });
    expect((await runs.allEvents(run.runId)).at(-1)).not.toHaveProperty("reason");
  });
});

describe("startOrSteer: the model pick and the thread's taint, on Floci", () => {
  // Only startOrSteer is told about this file; private content is anything with an attachment, uploaded or not.
  const file = { key: "rooms/r/u/f/report.pdf", name: "report.pdf", size: 1, type: "application/pdf" };

  async function idleThread() {
    const owner = user("owner");
    const { roomId } = await roomsRepo().createRoom(owner, "Picks");
    const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go tools:0", clientId: `k${++clients}` });
    return { owner, roomId, thread, message };
  }

  const taintOf = async (roomId: string, threadId: string) => (await threadsRepo().threadById(roomId, threadId))!.taint;

  it("a message with a file makes the thread private; with no pick the run takes the room default, Auto", async () => {
    const { owner, roomId, thread, message } = await idleThread();
    const { runId, started } = await startOrSteer(owner, roomId, thread.threadId, { ...message, attachments: [file] });
    expect(started).toBe(true);
    expect(await taintOf(roomId, thread.threadId)).toEqual(["attachment"]);
    expect(await runs.getRun(runId)).toMatchObject({ pick: "auto", pickBy: "default" });
    expect((await runs.allEvents(runId))[0]).toMatchObject({ type: "run.started", pick: "auto", startedBy: "owner" });
  });

  it("a pick sent with the message is the run's pick", async () => {
    const { owner, roomId, thread, message } = await idleThread();
    const { runId } = await startOrSteer(owner, roomId, thread.threadId, message, "opus");
    expect(await runs.getRun(runId)).toMatchObject({ pick: "opus", pickBy: "pick" });
    expect(await taintOf(roomId, thread.threadId)).toEqual([]);
  });

  it("a DeepSeek room default becomes Auto on a private thread, and stays DeepSeek on others", async () => {
    const { owner, roomId, thread, message } = await idleThread();
    await roomsRepo().setDefaultModel(owner, roomId, "deepseek-flash");
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(thread.number) },
      UpdateExpression: "ADD #taint :t", ExpressionAttributeNames: { "#taint": "taint" }, ExpressionAttributeValues: { ":t": new Set(["attachment"]) },
    }));
    const { runId } = await startOrSteer(owner, roomId, thread.threadId, message);
    expect(await runs.getRun(runId)).toMatchObject({ pick: "auto", pickBy: "default" });

    const open = await threadsRepo().createThread(owner, roomId, { text: "go tools:0", clientId: `k${++clients}` });
    const { runId: openRun } = await startOrSteer(owner, roomId, open.thread.threadId, open.message);
    expect(await runs.getRun(openRun)).toMatchObject({ pick: "deepseek-flash", pickBy: "default" });
  });

  it("a steer with a file makes the running thread private and leaves the run's pick as it was", async () => {
    const { owner, roomId, thread, run } = await runningThread();
    const steer = await chatRepo().send(owner, { roomId, chatId: thread.threadId, clientId: `k${++clients}`, text: "and this" });
    const result = await startOrSteer(owner, roomId, thread.threadId, { ...steer, attachments: [file] }, "deepseek-flash");
    expect(result).toEqual({ runId: run.runId, started: false });
    expect(await taintOf(roomId, thread.threadId)).toEqual(["attachment"]);
    expect(await runs.getRun(run.runId)).toMatchObject({ pick: "auto", pickBy: "default" });
  });
});
