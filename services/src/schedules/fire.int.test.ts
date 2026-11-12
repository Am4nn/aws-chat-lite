import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GetFunctionConfigurationCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentsRepo } from "../agents/repo.js";
import { auditRepo } from "../audit/repo.js";
import { budgetRepo } from "../budget/repo.js";
import { chatRepo } from "../chat/repo.js";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { runsRepo } from "../runs/repo.js";
import { threadsRepo } from "../threads/repo.js";
import { schedulesRepo } from "./repo.js";
import { scheduleTrigger } from "./scheduler.js";

// Runs against the deployed fire and run functions on Floci: npm run floci:up && npm run deploy:local, then
// npm -w services run test:int. Each fire is an invoke of the fire Lambda, as Scheduler makes it.
const lambda = new LambdaClient({});
const schedules = schedulesRepo();
const threads = threadsRepo();
const chat = chatRepo();
const runs = runsRepo();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let trigger: ReturnType<typeof scheduleTrigger>;
const armed: string[] = [];

beforeAll(async () => {
  const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: "cl-local-schedules" }));
  trigger = scheduleTrigger(new SchedulerClient({}), config.Environment?.Variables ?? {});
});

afterAll(() => Promise.all(armed.map((id) => trigger.remove(id))));

async function fire(roomId: string, scheduleId: string, at: string): Promise<string> {
  const res = await lambda.send(new InvokeCommand({ FunctionName: "cl-local-schedule-fire", Payload: JSON.stringify({ roomId, scheduleId, at }) }));
  const reply = JSON.parse(Buffer.from(res.Payload!).toString());
  if (res.FunctionError) throw new Error(`fire failed: ${JSON.stringify(reply)}`);
  return reply;
}

async function finished(runId: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const run = await runs.getRun(runId);
    if (run && run.status !== "running") return run;
    if (Date.now() > deadline) throw new Error("timed out waiting for the run to end");
    await sleep(250);
  }
}

/** A room with `scout` and its `Morning digest` into #general, every day at 09:00, switched on with a real trigger. */
async function digestRoom() {
  const owner = { userId: randomUUID(), username: "owner" };
  const rooms = roomsRepo();
  const { roomId, generalChatId } = await rooms.createRoom(owner, "Schedules");
  const scout = await agentsRepo().create(owner, roomId, { name: "scout", instructions: "Digest the news.", tools: ["web"], model: "room" });
  const schedule = await schedules.create(owner, roomId, {
    agentId: scout.agentId, title: "Morning digest", prompt: "Digest the news. tools:0", cadence: { kind: "daily", time: "09:00" }, chatId: generalChatId,
  });
  await trigger.put(roomId, schedule, "Asia/Kolkata");
  armed.push(schedule.scheduleId);
  const cards = async () => (await chat.history(owner, roomId, generalChatId, {})).messages.filter((m) => m.authorName === "schedule");
  return { owner, roomId, generalChatId, scout, schedule, scheduleId: schedule.scheduleId, cards };
}

/** Retired: the trigger is gone from Scheduler and the item, if any, is off. */
async function expectRetired(roomId: string, scheduleId: string) {
  expect(await trigger.get(scheduleId)).toBeNull();
  const item = await schedules.get(roomId, scheduleId);
  if (item) expect(item.enabled).toBe(false);
}

describe("scheduled fires on Floci", { timeout: 90_000 }, () => {
  it("a fire opens a dated thread for the schedule's agent, posts its card in the chat and runs to done", async () => {
    const at = await digestRoom();
    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T03:30:00Z")).toBe("started");

    const { lastRun } = (await schedules.get(at.roomId, at.scheduleId))!;
    expect(lastRun).toMatchObject({ at: "2026-11-10T03:30:00.000Z", threadNumber: expect.any(Number) });
    const thread = (await threads.threadByTag(at.roomId, { number: lastRun!.threadNumber! }))!;
    expect(thread).toMatchObject({ name: "morning-digest-nov-10", agentId: at.scout.agentId });

    const [card] = await at.cards();
    expect(card).toMatchObject({ text: "Morning digest", authorId: "schedule", threadRef: { kind: "started", threadId: thread.threadId } });
    expect((await finished(thread.runId!)).status).toBe("done");

    // The schedule has no read state: neither its card nor the thread's first message leaves a marker.
    for (const chatId of [at.generalChatId, thread.threadId]) {
      const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${at.roomId}`, sk: `READ#schedule#${chatId}` } }));
      expect(Item).toBeUndefined();
    }
    const { entries } = await auditRepo().list(at.roomId);
    expect(entries.find((e) => e.kind === "asked")).toMatchObject({ actor: "schedule", agent: "scout", threadNumber: thread.number });
  });

  it("a scheduled run waits on an approval like any other, and an unanswered one is skipped with a note", async () => {
    const owner = { userId: randomUUID(), username: "owner" };
    const { roomId, generalChatId } = await roomsRepo().createRoom(owner, "Scheduled writes");
    const db = docClient();
    await db.send(new PutCommand({
      TableName: tableName(),
      Item: { pk: `ROOM#${roomId}`, sk: "LINK#github", installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "owner", addedAt: new Date().toISOString() },
    }));
    await db.send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: "META" }, UpdateExpression: "SET approvalTimeoutSec = :s", ExpressionAttributeValues: { ":s": 5 },
    }));
    const bot = await agentsRepo().create(owner, roomId, { name: "bot", instructions: "Comment daily.", tools: ["github"], model: "room" });
    const schedule = await schedules.create(owner, roomId, {
      agentId: bot.agentId, title: "Daily comment", prompt: "go call:github_comment", cadence: { kind: "daily", time: "09:00" }, chatId: generalChatId,
    });
    await trigger.put(roomId, schedule, "Asia/Kolkata");
    armed.push(schedule.scheduleId);

    expect(await fire(roomId, schedule.scheduleId, "2026-11-10T03:30:00Z")).toBe("started");
    const { lastRun } = (await schedules.get(roomId, schedule.scheduleId))!;
    const thread = (await threads.threadByTag(roomId, { number: lastRun!.threadNumber! }))!;
    const deadline = Date.now() + 30_000;
    while ((await threads.threadById(roomId, thread.threadId))?.status !== "waiting") {
      if (Date.now() > deadline) throw new Error("timed out waiting for the approval");
      await sleep(250);
    }
    expect((await threads.threadById(roomId, thread.threadId))?.approval).toMatchObject({ step: 1 });

    expect((await finished(thread.runId!)).status).toBe("done");
    const text = (await runs.allEvents(thread.runId!)).map((e) => (e.type === "text" ? e.text : "")).join("");
    expect(text).toContain("(Skipped because no one approved in time:");
  });

  it("the same occurrence again is a duplicate, and another one that day gets the next name", async () => {
    const at = await digestRoom();
    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T03:30:00Z")).toBe("started");
    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T03:30:00Z")).toBe("duplicate");
    expect(await at.cards()).toHaveLength(1);

    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T09:30:00Z")).toBe("started");
    const { lastRun } = (await schedules.get(at.roomId, at.scheduleId))!;
    expect((await threads.threadByTag(at.roomId, { number: lastRun!.threadNumber! }))?.name).toBe("morning-digest-nov-10-2");
    expect(await at.cards()).toHaveLength(2);
  });

  it("a schedule switched off retires its trigger and opens nothing", async () => {
    const at = await digestRoom();
    await schedules.setEnabled(at.roomId, at.scheduleId, false);
    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T03:30:00Z")).toBe("retired");
    await expectRetired(at.roomId, at.scheduleId);
    expect(await at.cards()).toEqual([]);
  });

  it("an archived room retires the trigger and switches the schedule off", async () => {
    const at = await digestRoom();
    await roomsRepo().archiveRoom(at.roomId, at.owner.userId);
    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T03:30:00Z")).toBe("retired");
    await expectRetired(at.roomId, at.scheduleId);
  });

  it("a deleted agent retires the trigger", async () => {
    const at = await digestRoom();
    await agentsRepo().remove(at.owner, at.roomId, at.scout.agentId);
    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T03:30:00Z")).toBe("retired");
    await expectRetired(at.roomId, at.scheduleId);
    expect(await at.cards()).toEqual([]);
  });

  it("a room whose budget is spent gets a note on the schedule and no thread", async () => {
    const at = await digestRoom();
    await budgetRepo().setCap(at.owner, at.roomId, 0);
    expect(await fire(at.roomId, at.scheduleId, "2026-11-10T03:30:00Z")).toBe("skipped");
    expect((await schedules.get(at.roomId, at.scheduleId))?.lastRun).toEqual({
      at: "2026-11-10T03:30:00.000Z", skipped: "Skipped: the room's budget is spent.",
    });
    expect(await at.cards()).toEqual([]);
  });
});
