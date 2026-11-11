import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { budgetRepo } from "../budget/repo.js";
import { budgetText, monthKey } from "../budget/model.js";
import { threadSk } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { Attachment } from "../chat/model.js";
import type { ModelPick } from "../models/catalog.js";
import { RUN_REFUSED } from "../models/privacy.js";
import type { RunEvent } from "../threads/types.js";
import { issueTicket } from "../live/tickets.js";
import { runsRepo } from "./repo.js";
import { startOrSteer } from "./start.js";
import { requestStop } from "./stop.js";
import { streamRun } from "./stream.js";
import { issueStreamTicket } from "./stream-tickets.js";

// Runs against the deployed run function on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
const wsUrl = String(outputs["cl-local-core"].WsUrl);
process.env.WS_CALLBACK_URL = wsUrl.replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

const runs = runsRepo();
const chat = chatRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const useUpBudget = (roomId: string) =>
  docClient().send(new TransactWriteCommand({ TransactItems: [budgetRepo().spend(roomId, 3_000_000, new Date())] }));
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
async function startRun(text: string, at?: Awaited<ReturnType<typeof room>>, pick?: ModelPick) {
  const { owner, roomId } = at ?? await room();
  const { thread, message } = await threadsRepo().createThread(owner, roomId, { text, clientId: `k${++clients}` });
  const started = await startOrSteer(owner, roomId, thread.threadId, message, pick);
  return { owner, roomId, thread, ...started };
}

/** A member's message in the thread, delivered to the run as a steer. */
async function steer(
  owner: { userId: string; username: string }, roomId: string, threadId: string, text: string,
  opts: { attachments?: Attachment[]; pick?: ModelPick } = {},
) {
  // Handing the send its attachments as already checked skips the S3 lookup a real upload passes.
  const admitted = opts.attachments && { text, attachments: opts.attachments };
  const message = await chat.send(owner, { roomId, chatId: threadId, clientId: `k${++clients}`, text }, admitted);
  return startOrSteer(owner, roomId, threadId, message, opts.pick);
}

const file: Attachment = { key: "rooms/r/u/f/report.pdf", name: "report.pdf", size: 1, type: "application/pdf" };
/** Each usage event as `job:model`, in order. */
const usageOf = (events: RunEvent[]) => events.flatMap((e) => (e.type === "usage" ? [`${e.job}:${e.model}`] : []));

type Frame = Record<string, any>;
const sockets: WebSocket[] = [];
afterEach(() => { for (const ws of sockets.splice(0)) ws.terminate(); });

/** A member's live socket, recording every frame it gets. */
async function listen(u: { userId: string; username: string }): Promise<Frame[]> {
  const { ticket } = await issueTicket(u);
  const ws = new WebSocket(`${wsUrl}?ticket=${ticket}`);
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return frames;
}

const answersIn = async (owner: { userId: string; username: string }, roomId: string, threadId: string) =>
  (await chat.history(owner, roomId, threadId, {})).messages.filter((m) => m.authorId === "agent");

// Each durable step checkpoints through Floci, which takes up to a second or two while other suites share it.
describe("the run loop on Floci", { timeout: 60_000 }, () => {
  it("tools:2 → two steps, the answer, usage and a thread name; the month's spend rises by the run's cost", async () => {
    const { owner, roomId, thread, runId, started } = await startRun("go tools:2 words:10");
    expect(started).toBe(true);
    const run = await finished(runId);
    expect(run.status).toBe("done");

    const events = await runs.events(runId, 0, 1000);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const shape = events.map((e) => (e.type === "usage" ? `usage:${e.job}` : e.type));
    // The router and the naming call, then three model turns: two tool calls, then the answer.
    expect(shape.filter((t) => t !== "text")).toEqual([
      "run.started", "usage:route", "routed", "usage:name",
      "model.turn", "usage:run", "step.started", "step.finished",
      "model.turn", "usage:run", "step.started", "step.finished",
      "model.turn", "usage:run", "run.finished",
    ]);
    expect(new Set(shape.slice(shape.lastIndexOf("step.finished") + 1, -3))).toEqual(new Set(["text"]));

    const usage = events.flatMap((e) => (e.type === "usage" ? [e.costMicros] : []));
    const cost = usage.reduce((a, b) => a + b, 0);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "done", steps: 2, costMicros: cost });

    const [answer] = await answersIn(owner, roomId, thread.threadId);
    expect(answer!.agent).toMatchObject({ runId, status: "done", steps: 2, costMicros: cost, firstSeq: 1 });
    expect(answer!.text).toBe(events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""));
    expect(await threadsRepo().threadById(roomId, thread.threadId)).toMatchObject({
      name: "go-tools-2", status: "done", steps: 2, costMicros: cost, summary: 'Fake answer for "go".',
    });
    expect((await budgetRepo().get(roomId, new Date())).spentMicros).toBe(cost);
  });

  it("the room hears the run: run.updated with the cost while it streams, then the answer as message.new", async () => {
    const at = await room();
    const frames = await listen(at.owner);
    const { thread, runId } = await startRun("go tools:0 words:3", at);
    await finished(runId);
    const answer = await until("the answer frame", async () =>
      frames.find((f) => f.type === "message.new" && f.message.authorId === "agent"));
    expect(answer.message).toMatchObject({ chatId: thread.threadId, seq: 2, agent: { runId, status: "done" } });
    const updates = frames.filter((f) => f.type === "run.updated" && f.thread.threadId === thread.threadId);
    expect(updates.some((f) => f.thread.status === "running" && f.thread.costMicros > 0 && f.budget.spentMicros > 0)).toBe(true);
    expect(await until("the done frame", async () =>
      frames.find((f) => f.type === "run.updated" && f.thread.status === "done"))).toBeDefined();
  });

  it("a seq nobody filled (a send that died after taking its number) doesn't keep the run from closing", async () => {
    const { owner, roomId } = await room();
    const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go tools:0 words:3", clientId: `k${++clients}` });
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `CHAT#${thread.threadId}`, sk: "META" }, UpdateExpression: "ADD lastSeq :one",
      ExpressionAttributeValues: { ":one": 1 },
    }));
    const { runId } = await startOrSteer(owner, roomId, thread.threadId, message);
    expect((await finished(runId)).status).toBe("done");
    const events = await runs.allEvents(runId);
    // One model turn: the hole never made the run go round again.
    expect(usageOf(events).filter((u) => u.startsWith("run:"))).toHaveLength(1);
    expect((await answersIn(owner, roomId, thread.threadId))[0]).toMatchObject({ seq: 3 });
  });

  it("a thread its first run couldn't name is named by a later run", async () => {
    const at = await room();
    await useUpBudget(at.roomId);
    const { thread, runId } = await startRun("go tools:0 words:3", at);
    expect((await finished(runId)).status).toBe("capped");
    await budgetRepo().setCap(at.owner, at.roomId, 5_000_000);
    const next = await steer(at.owner, at.roomId, thread.threadId, "try again");
    expect(next.started).toBe(true);
    expect((await finished(next.runId)).status).toBe("done");
    expect((await threadsRepo().threadById(at.roomId, thread.threadId))?.name).toBe("go-tools-0");
  });

  it("a message during a step steers the run: one more step, then done", async () => {
    const { owner, roomId, thread, runId } = await startRun("slow tools:2 words:5");
    await eventOf(runId, (e) => e.type === "step.started");
    expect(await steer(owner, roomId, thread.threadId, "also check prod")).toEqual({ runId, started: false });
    expect((await finished(runId, 40_000)).status).toBe("done");

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
    // The second turn's text starts its own paragraph.
    expect(answers[0]!.text).toMatch(/\.\n\nFake answer for/);
    expect(answers[0]!.seq).toBe(3);
  });

  it("Stop: the streaming answer ends within 3 s, keeping the text so far", async () => {
    const { owner, roomId, thread, runId } = await startRun("slow words:400");
    await eventOf(runId, (e) => e.type === "text");
    expect(await requestStop(owner, roomId, thread.threadId)).toEqual({ runId });
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

  it("a room at its cap ends the run capped before any model call, the router's included", async () => {
    const at = await room();
    await useUpBudget(at.roomId);
    const { thread, runId } = await startRun("go tools:1", at);
    const run = await finished(runId);
    expect(run.status).toBe("capped");

    const events = await runs.events(runId, 0, 1000);
    expect(events.some((e) => e.type === "usage")).toBe(false);
    // Auto at the cap takes Sonnet without asking the router.
    expect(events.find((e) => e.type === "routed")).toMatchObject({ model: "claude-sonnet-5-5", by: "auto" });
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

  it("a thread whose run started over 135 minutes ago is not wedged: the next message starts a new run", async () => {
    const { owner, roomId } = await room();
    const { thread, message } = await threadsRepo().createThread(owner, roomId, { text: "go tools:0 words:3", clientId: `k${++clients}` });
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(thread.number) },
      UpdateExpression: "SET activeRunId = :dead, startedAt = :then, #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":dead": "dead-run", ":then": new Date(Date.now() - 136 * 60_000).toISOString(), ":running": "running" },
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

describe("routing, privacy and how a model call ends, on Floci", { timeout: 60_000 }, () => {
  it("Auto asks the router on Haiku, then answers on Sonnet; naming runs on Haiku", async () => {
    const { owner, roomId, thread, runId } = await startRun("go tools:0 words:5");
    expect((await finished(runId)).status).toBe("done");
    const events = await runs.events(runId, 0, 1000);
    expect(events.filter((e) => e.type === "routed")).toEqual([expect.objectContaining({ model: "claude-sonnet-5-5", by: "auto" })]);
    expect(usageOf(events)).toEqual(["route:claude-haiku-5-5", "name:claude-haiku-5-5", "run:claude-sonnet-5-5"]);
    const [answer] = await answersIn(owner, roomId, thread.threadId);
    expect(answer!.agent).toMatchObject({ pick: "auto", model: "claude-sonnet-5-5" });
  });

  it("Auto takes Haiku when the router says haiku, and never escalates past Sonnet", async () => {
    const haiku = await startRun("route:haiku hi tools:0");
    const opus = await startRun("route:opus hi tools:0");
    for (const [{ runId }, model] of [[haiku, "claude-haiku-5-5"], [opus, "claude-sonnet-5-5"]] as const) {
      expect((await finished(runId)).status).toBe("done");
      expect((await runs.events(runId, 0, 1000)).find((e) => e.type === "routed")).toMatchObject({ model, by: "auto" });
    }
  });

  it("a manual pick routes straight to its model, with no router call", async () => {
    const { runId } = await startRun("go tools:0 words:3", undefined, "opus");
    expect((await finished(runId)).status).toBe("done");
    const events = await runs.events(runId, 0, 1000);
    expect(events.find((e) => e.type === "routed")).toMatchObject({ model: "claude-opus-5-5", by: "pick" });
    expect(usageOf(events)).toEqual(["name:claude-haiku-5-5", "run:claude-opus-5-5"]);
  });

  it("each model call that ended logs its native turn, and the event stream never sends one", async () => {
    const { owner, runId } = await startRun("go tools:2 words:3");
    expect((await finished(runId)).status).toBe("done");
    const turns = (await runs.events(runId, 0, 1000)).filter((e) => e.type === "model.turn");
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ model: "claude-sonnet-5-5", content: { fake: true, calls: ["call-1"] } });

    let body = "";
    const sink = { status: () => {}, write: (chunk: string) => { body += chunk; }, end: () => {} };
    await streamRun({ runId, ticket: (await issueStreamTicket(owner, runId)).ticket }, sink);
    expect(body).toContain('"type":"run.finished"');
    expect(body).not.toContain('"type":"model.turn"');
  });

  it("a file steered into a DeepSeek run stops it before its next model call", async () => {
    const { owner, roomId, thread, runId } = await startRun("slow tools:2", undefined, "deepseek-flash");
    await eventOf(runId, (e) => e.type === "step.started");
    expect(await steer(owner, roomId, thread.threadId, "and this", { attachments: [file] })).toEqual({ runId, started: false });
    expect(await finished(runId)).toMatchObject({ status: "failed", reason: RUN_REFUSED });
    const events = await runs.events(runId, 0, 1000);
    const steerSeq = events.find((e) => e.type === "steer")!.seq;
    expect(events.some((e) => e.type === "usage" && e.job === "run" && e.seq > steerSeq)).toBe(false);
  });

  it("a file already in the thread stops a DeepSeek run, even when the thread never recorded its taint", async () => {
    const { owner, roomId } = await room();
    const { thread } = await threadsRepo().createThread(owner, roomId, { text: "first", clientId: `k${++clients}` });
    // A plain send stores the file without telling any run, so the thread's taint stays unwritten.
    await chat.send(owner, { roomId, chatId: thread.threadId, clientId: `k${++clients}`, text: "the file" }, { text: "the file", attachments: [file] });
    expect((await threadsRepo().threadById(roomId, thread.threadId))!.taint).toEqual([]);
    const { runId } = await steer(owner, roomId, thread.threadId, "go tools:0", { pick: "deepseek-flash" });
    expect(await finished(runId)).toMatchObject({ status: "failed", reason: RUN_REFUSED });
    expect(usageOf(await runs.events(runId, 0, 1000)).some((u) => u.startsWith("run:"))).toBe(false);
  });

  it("a call that drops mid-answer ends the run failed, keeping its text once", async () => {
    const { owner, roomId, thread, runId } = await startRun("drop:5 words:20");
    expect(await finished(runId)).toMatchObject({ status: "failed", reason: "The model's connection dropped mid-answer." });
    const [answer] = await answersIn(owner, roomId, thread.threadId);
    expect(answer!.text.match(/Fake answer for/g)).toHaveLength(1);
  });

  it("an answer cut off at the length limit runs no tools and ends done with a note", async () => {
    const { owner, roomId, thread, runId } = await startRun("cutoff");
    expect((await finished(runId)).status).toBe("done");
    expect((await runs.events(runId, 0, 1000)).some((e) => e.type === "step.started")).toBe(false);
    const [answer] = await answersIn(owner, roomId, thread.threadId);
    expect(answer!.text.endsWith("\n\n(The answer was cut off at the length limit.)")).toBe(true);
  });

  it("a model that declines ends the run failed with the refusal copy", async () => {
    const { runId } = await startRun("refuse");
    expect(await finished(runId)).toMatchObject({ status: "failed", reason: "The model declined this request. Try another model." });
  });
});
