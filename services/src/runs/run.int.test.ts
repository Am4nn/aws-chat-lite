import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { budgetRepo } from "../budget/repo.js";
import { budgetText, monthKey } from "../budget/model.js";
import { threadSk } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEvent } from "../threads/types.js";
import { runsRepo } from "./repo.js";
import { startOrSteer } from "./start.js";

// Runs against the deployed run function on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

const runs = runsRepo();
const chat = chatRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

/** The run once it has closed and written `run.finished`, which follows the close. */
const finished = (runId: string, ms?: number) =>
  until("the run to end", async () => {
    const run = await runs.getRun(runId);
    if (!run || run.status === "running") return undefined;
    return (await runs.allEvents(runId)).at(-1)?.type === "run.finished" ? run : undefined;
  }, ms);

const eventOf = (runId: string, match: (e: RunEvent) => boolean) =>
  until("an event", async () => (await runs.events(runId, 0, 1000)).find(match));

const threadItem = async (roomId: string, n: number) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(n) }, ConsistentRead: true }))).Item;

async function room() {
  const owner = user("owner");
  const { roomId } = await roomsRepo().createRoom(owner, "Agents");
  return { owner, roomId };
}

/** A new thread whose first message starts a run, the way a member's first message does. */
async function startRun(text: string, at?: Awaited<ReturnType<typeof room>>) {
  const { owner, roomId } = at ?? await room();
  const { thread, message } = await threadsRepo().createThread(owner, roomId, { text, clientId: `k${++clients}` });
  const started = await startOrSteer(owner, roomId, thread.threadId, message);
  return { owner, roomId, thread, ...started };
}

/** A member's message in the thread, delivered to the run as a steer. */
async function steer(owner: { userId: string; username: string }, roomId: string, threadId: string, text: string) {
  const message = await chat.send(owner, { roomId, chatId: threadId, clientId: `k${++clients}`, text });
  return startOrSteer(owner, roomId, threadId, message);
}

const answersIn = async (owner: { userId: string; username: string }, roomId: string, threadId: string) =>
  (await chat.history(owner, roomId, threadId, {})).messages.filter((m) => m.authorId === "agent");

describe("the run loop on Floci", () => {
  it("tools:2 → two steps, the answer, usage and a thread name; the month's spend rises by the run's cost", async () => {
    const { owner, roomId, thread, runId, started } = await startRun("go tools:2 words:10");
    expect(started).toBe(true);
    const run = await finished(runId);
    expect(run.status).toBe("done");

    const events = await runs.events(runId, 0, 1000);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const shape = events.filter((e) => e.type !== "usage").map((e) => e.type);
    expect(shape.slice(0, 5)).toEqual(["run.started", "step.started", "step.finished", "step.started", "step.finished"]);
    expect(new Set(shape.slice(5, -1))).toEqual(new Set(["text"]));
    expect(events.slice(-2).map((e) => e.type)).toEqual(["usage", "run.finished"]);

    const usage = events.flatMap((e) => (e.type === "usage" ? [e.costMicros] : []));
    const cost = usage.reduce((a, b) => a + b, 0);
    // The naming call and three model turns (two tool calls, then the answer).
    expect(usage).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "done", steps: 2, costMicros: cost });

    const [answer] = await answersIn(owner, roomId, thread.threadId);
    expect(answer!.agent).toMatchObject({ runId, status: "done", steps: 2, costMicros: cost, firstSeq: 1 });
    expect(answer!.text).toBe(events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""));
    expect(await threadsRepo().threadById(roomId, thread.threadId)).toMatchObject({
      name: "go-tools-2", status: "done", steps: 2, costMicros: cost, summary: 'Fake answer for "go".',
    });
    expect((await budgetRepo().get(roomId, new Date())).spentMicros).toBe(cost);
  });

  it("a message during a step steers the run: one more step, then done", async () => {
    const { owner, roomId, thread, runId } = await startRun("slow tools:2 words:5");
    await eventOf(runId, (e) => e.type === "step.started");
    expect(await steer(owner, roomId, thread.threadId, "also check prod")).toEqual({ runId, started: false });
    expect((await finished(runId)).status).toBe("done");

    const events = await runs.events(runId, 0, 1000);
    expect(events.find((e) => e.type === "steer")).toMatchObject({ messageSeq: 2, authorName: "owner", text: "also check prod" });
    expect(events.filter((e) => e.type === "step.finished")).toHaveLength(3);
    expect((await answersIn(owner, roomId, thread.threadId))[0]).toMatchObject({ seq: 3, agent: { steps: 3 } });
  });

  it("a message while the answer streams fails the close, so the run reads it and answers again, once", async () => {
    const { owner, roomId, thread, runId } = await startRun("slow tools:0 words:60");
    await eventOf(runId, (e) => e.type === "text");
    await steer(owner, roomId, thread.threadId, "and one more");
    expect((await finished(runId, 45_000)).status).toBe("done");

    const events = await runs.events(runId, 0, 1000);
    const steerAt = events.findIndex((e) => e.type === "steer");
    // The steer follows the first answer's text: the run only read it after its first close found it unread.
    expect(events.slice(0, steerAt).some((e) => e.type === "text")).toBe(true);
    expect(events.filter((e) => e.type === "run.finished")).toHaveLength(1);
    const answers = await answersIn(owner, roomId, thread.threadId);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.text.match(/Fake answer for/g)).toHaveLength(2);
    expect(answers[0]!.seq).toBe(3);
  }, 60_000);

  it("Stop: the streaming answer ends within 3 s, keeping the text so far", async () => {
    const { owner, roomId, thread, runId } = await startRun("slow words:400");
    await eventOf(runId, (e) => e.type === "text");
    expect(await runs.requestStop(owner, roomId, thread.threadId)).toEqual({ runId });
    const stoppedAt = Date.now();
    const run = await finished(runId, 3_000);
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    expect(run.status).toBe("stopped");

    const events = await runs.events(runId, 0, 1000);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "stopped", reason: "Stopped by owner." });
    const [answer] = await answersIn(owner, roomId, thread.threadId);
    expect(answer!.text).toMatch(/^Fake answer for/);
    expect(answer!.text.split(" ").length).toBeLessThan(400);
    expect(answer!.agent).toMatchObject({ status: "stopped", reason: "Stopped by owner." });
  });

  it("a room at its cap ends the run capped before any model call", async () => {
    const at = await room();
    await budgetRepo().record(at.roomId, 3_000_000, new Date());
    const { thread, runId } = await startRun("go tools:1", at);
    const run = await finished(runId);
    expect(run.status).toBe("capped");

    const events = await runs.events(runId, 0, 1000);
    expect(events.some((e) => e.type === "usage")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "capped", reason: budgetText(3_000_000, monthKey(new Date())) });
    expect((await threadsRepo().threadById(at.roomId, thread.threadId))?.name).toBe(thread.name);
  });

  it("a model that keeps failing ends the run failed and frees the thread", async () => {
    const { roomId, thread, runId } = await startRun("fail");
    const run = await finished(runId);
    expect(run.status).toBe("failed");
    expect((await runs.events(runId, 0, 1000)).at(-1)).toMatchObject({ type: "run.finished", reason: "The agent hit an error." });
    const item = await threadItem(roomId, thread.number);
    expect(item).toMatchObject({ status: "failed" });
    expect(item?.activeRunId).toBeUndefined();
  });

  it("a run that couldn't be invoked is marked failed and frees the thread", async () => {
    process.env.RUN_FN_NAME = "cl-local-no-such-function";
    try {
      const { roomId, thread, runId } = await startRun("go");
      expect(await runs.getRun(runId)).toMatchObject({ status: "failed" });
      expect((await runs.events(runId, 0)).at(-1)).toMatchObject({ type: "run.finished", reason: "The run couldn't start." });
      expect((await threadItem(roomId, thread.number))?.activeRunId).toBeUndefined();
    } finally {
      process.env.RUN_FN_NAME = "cl-local-run";
    }
  });

  it("a thread whose run started over 130 minutes ago is not wedged: the next message starts a new run", async () => {
    const { owner, roomId } = await room();
    const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go tools:0 words:3", clientId: `k${++clients}` });
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(thread.number) },
      UpdateExpression: "SET activeRunId = :dead, startedAt = :then, #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":dead": "dead-run", ":then": new Date(Date.now() - 131 * 60_000).toISOString(), ":running": "running" },
    }));
    const { runId, started } = await startOrSteer(owner, roomId, thread.threadId, message);
    expect(started).toBe(true);
    expect(runId).not.toBe("dead-run");
    expect((await finished(runId)).status).toBe("done");
  });

  it("the threads Lambda starts the run itself (a Lambda invoking the durable alias)", async () => {
    const { owner, roomId } = await room();
    const event = {
      routeKey: "POST /rooms/{roomId}/threads", pathParameters: { roomId },
      body: JSON.stringify({ text: "go tools:1 words:3", clientId: `k${++clients}` }),
      requestContext: { authorizer: { jwt: { claims: { sub: owner.userId, "cognito:username": owner.username } } } },
    };
    const res = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: "cl-local-threads", Payload: JSON.stringify(event) }));
    const reply = JSON.parse(Buffer.from(res.Payload!).toString());
    expect(reply.statusCode).toBe(201);
    const { thread } = JSON.parse(reply.body);
    expect(thread).toMatchObject({ status: "running", runFirstSeq: 1 });
    expect((await finished(thread.runId)).status).toBe("done");
  });
});
