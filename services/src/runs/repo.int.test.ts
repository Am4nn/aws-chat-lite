import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { Conflict } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { threadSk } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import { runsRepo, type Run } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const runs = runsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
let clients = 0;

const get = async (pk: string, sk: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk, sk }, ConsistentRead: true }))).Item;

/** A thread whose first message started a run, written straight to the table so no run function is invoked. */
async function runningThread() {
  const owner = user("owner");
  const { roomId } = await roomsRepo().createRoom(owner, "Runs");
  const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go", clientId: `k${++clients}` });
  const run: Run = {
    runId: randomUUID(), roomId, threadId: thread.threadId, number: thread.number, status: "running", model: "fake",
    startedBy: owner.username, startedAt: new Date().toISOString(), firstSeq: message.seq, seenSeq: message.seq, steps: 0,
    costMicros: 0,
  };
  await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RUN#${run.runId}`, sk: "META", ...run } }));
  await docClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(thread.number) },
    UpdateExpression: "SET activeRunId = :r, runId = :r, #status = :running", ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":r": run.runId, ":running": "running" },
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

    const close = (seenSeq: number) => runs.closeRun(run, { status: "done", text: "Fake answer.\n\nbody", seenSeq, force: false });
    expect(await close(1)).toBe("unread");
    expect(await threadItem(roomId, thread.number)).toMatchObject({ activeRunId: run.runId, status: "running" });

    expect(await close(2)).toBe("closed");
    const { messages } = await chatRepo().history(owner, roomId, thread.threadId, {});
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages[2]).toMatchObject({
      authorId: "agent", authorName: "agent", text: "Fake answer.\n\nbody",
      agent: { runId: run.runId, status: "done", steps: 0, costMicros: 0, model: "fake", firstSeq: 1 },
    });
    const closed = await threadItem(roomId, thread.number);
    expect(closed).toMatchObject({ status: "done", summary: "Fake answer.", rev: thread.rev + 1 });
    expect(closed?.activeRunId).toBeUndefined();
    expect(await runs.getRun(run.runId)).toMatchObject({ status: "done", answerSeq: 3 });

    expect(await close(3)).toBe("already");
    expect((await chatRepo().history(owner, roomId, thread.threadId, {})).messages.filter((m) => m.authorId === "agent")).toHaveLength(1);
  });

  it("a forced close lands past messages it has not read", async () => {
    const { owner, roomId, thread, run } = await runningThread();
    await chatRepo().send(owner, { roomId, chatId: thread.threadId, clientId: `k${++clients}`, text: "late" });
    expect(await runs.closeRun(run, { status: "stopped", reason: "Stopped by owner.", text: "", seenSeq: 1, force: true })).toBe("closed");
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
    expect(await runs.requestStop(owner, roomId, thread.threadId)).toEqual({ runId: run.runId });
    expect(await runs.getRun(run.runId)).toMatchObject({ stopRequestedBy: "owner" });

    const idle = await threadsRepo().createThread(owner, roomId, { text: "idle", clientId: `k${++clients}` });
    await expect(runs.requestStop(owner, roomId, idle.thread.threadId)).rejects.toThrow(new Conflict("Nothing is running."));
  });
});
