import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BatchWriteCommand, QueryCommand, type BatchWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { budgetRepo } from "../budget/repo.js";
import { docClient, tableName } from "../lib/db.js";
import { chatRepo } from "../chat/repo.js";
import { issueTicket } from "../live/tickets.js";
import { roomsRepo } from "../rooms/repo.js";
import { runsRepo } from "./repo.js";

// 25 agent runs at once, watched by 100 sockets, against the deployed stack on Floci with the fake model:
// npm run deploy:local, then npm -w services run test:load
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
const wsUrl: string = outputs["cl-local-core"].WsUrl;
process.env.WS_CALLBACK_URL = wsUrl.replace(/^ws/, "http");

const USERS = 10;
const SOCKETS_PER_USER = 10;
const OPEN_AT_ONCE = 10;
const SENDERS = 5;
const SENDS_PER_SENDER = 5;
const RUNS = SENDERS * SENDS_PER_SENDER;
const WITHIN_MS = 300_000;
const CALLS_PER_RUN = ["route", "name", "run", "run", "run"];

type Frame = Record<string, any>;
type Socket = { ws: WebSocket; frames: { frame: Frame; atMs: number }[] };

const sockets: Socket[] = [];
async function itemsOf(pk: string): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await docClient().send(new QueryCommand({
      TableName: tableName(), KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": pk }, ExclusiveStartKey: start,
    }));
    items.push(...page.Items ?? []);
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

async function remove(items: Record<string, any>[]) {
  for (let i = 0; i < items.length; i += 25) {
    let requests: BatchWriteCommandInput["RequestItems"] = {
      [tableName()]: items.slice(i, i + 25).map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
    };
    while (requests && Object.keys(requests).length) requests = (await docClient().send(new BatchWriteCommand({ RequestItems: requests }))).UnprocessedItems;
  }
}

/**
 * Floci slows down as its table fills, so the test deletes what it wrote: the room's partition and those of the
 * chats, threads and runs it lists, then the users' own.
 */
async function purge(roomId: string, users: { userId: string }[], inviteCode: string) {
  const room = await itemsOf(`ROOM#${roomId}`);
  const linked = room.flatMap((i) => [i.chatId && `CHAT#${i.chatId}`, i.threadId && `CHAT#${i.threadId}`, i.runId && `RUN#${i.runId}`]);
  const own = users.flatMap((u) => [`USER#${u.userId}`, `RATE#${u.userId}`]);
  for (const pk of new Set([...linked.filter(Boolean), ...own, `INVITE#${inviteCode}`])) await remove(await itemsOf(pk));
  await remove(room);
}
let cleanup: (() => Promise<void>) | undefined;

afterAll(async () => {
  sockets.forEach((s) => s.ws.terminate());
  await cleanup?.();
});

async function connect(user: { userId: string; username: string }): Promise<Socket> {
  const { ticket } = await issueTicket(user);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?ticket=${ticket}`);
    const socket: Socket = { ws, frames: [] };
    sockets.push(socket);
    ws.on("message", (data) => socket.frames.push({ frame: JSON.parse(String(data)), atMs: Date.now() }));
    ws.once("open", () => resolve(socket));
    ws.once("error", reject);
  });
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil((p / 100) * values.length) - 1]!;
const isDone = (f: Frame, threadId: string) => f.type === "run.updated" && f.thread.threadId === threadId && f.thread.status === "done";

describe("load on Floci", () => {
  it(`${RUNS} concurrent agent runs, fanned out to ${USERS * SOCKETS_PER_USER} sockets, metered exactly`, async () => {
    const users = Array.from({ length: USERS }, (_, i) => ({ userId: randomUUID(), username: `load${i}` }));
    const rooms = roomsRepo();
    const { roomId, generalChatId } = await rooms.createRoom(users[0]!, "Load");
    const { code } = await rooms.rotateInvite(roomId, users[0]!.userId);
    cleanup = () => purge(roomId, users, code);
    for (const u of users.slice(1)) await rooms.acceptInvite(code, u);
    // Far above what the runs spend, so no run is capped and every one reaches done.
    await budgetRepo().setCap(users[0]!, roomId, 50_000_000);

    const byUser: Socket[][] = users.map(() => []);
    const opens = users.flatMap((u, i) => Array.from({ length: SOCKETS_PER_USER }, () => async () => { byUser[i]!.push(await connect(u)); }));
    for (let i = 0; i < opens.length; i += OPEN_AT_ONCE) await Promise.all(opens.slice(i, i + OPEN_AT_ONCE).map((open) => open()));

    // Each sender's first socket sends; its acks and the message.updated that links each message to its thread map
    // every send to its run.
    const sentAt = new Map<string, number>();
    const t0 = Date.now();
    for (let u = 0; u < SENDERS; u++) {
      for (let k = 0; k < SENDS_PER_SENDER; k++) {
        const requestId = `${u}-${k}`;
        sentAt.set(requestId, Date.now());
        byUser[u]![0]!.ws.send(JSON.stringify({
          action: "send", requestId, roomId, chatId: generalChatId, clientId: randomUUID(), text: `@agent load-${u}-${k} tools:2 words:40`,
        }));
      }
    }

    const all = byUser.flat();
    const threadOf = () => {
      const seqToRequest = new Map<number, string>();
      for (const s of byUser.slice(0, SENDERS).map((b) => b[0]!)) {
        for (const { frame } of s.frames) if (frame.type === "ack" && frame.ok) seqToRequest.set(frame.data.seq, frame.requestId);
      }
      const threads = new Map<string, string>();
      for (const { frame } of all[0]!.frames) {
        const m = frame.type === "message.updated" ? frame.message : undefined;
        if (m?.chatId === generalChatId && m.threadRef?.kind === "started" && seqToRequest.has(m.seq)) threads.set(seqToRequest.get(m.seq)!, m.threadRef.threadId);
      }
      return threads;
    };
    const everyoneSawDone = (threads: Map<string, string>) =>
      threads.size === RUNS && all.every((s) => [...threads.values()].every((t) => s.frames.some(({ frame }) => isDone(frame, t))));
    let threads = threadOf();
    while (!everyoneSawDone(threads) && Date.now() - t0 < WITHIN_MS) {
      await new Promise((r) => setTimeout(r, 1000));
      threads = threadOf();
    }
    expect(threads.size).toBe(RUNS);
    expect(everyoneSawDone(threads)).toBe(true);

    const runs = runsRepo();
    const runIds = new Set<string>();
    for (const [requestId, threadId] of threads) {
      const done = all[0]!.frames.find(({ frame }) => isDone(frame, threadId))!.frame;
      const runId: string = done.thread.runId;
      runIds.add(runId);
      const seqs = (await runs.allEvents(runId)).map((e) => e.seq);
      expect(seqs, `run ${runId} (${requestId}) has gapless events`).toEqual(seqs.map((_, i) => i + 1));
      const { messages } = await chatRepo().history(users[0]!, roomId, threadId, {});
      expect(messages.filter((m) => m.authorId === "agent")).toHaveLength(1);
    }
    expect(runIds.size).toBe(RUNS);
    const costs = await Promise.all([...runIds].map(async (id) => (await runs.getRun(id))!));
    expect(costs.every((r) => r.status === "done")).toBe(true);
    // The calls each run makes are known from its message: Auto's router, the thread's name, then three turns for two
    // tools. One usage event per call, adding up to the run's cost, is what rules out a call charged twice; the spend
    // matching the run costs alone would not, since both come from the same events.
    for (const run of costs) {
      const usage = (await runs.allEvents(run.runId)).flatMap((e) => (e.type === "usage" ? [e] : []));
      expect(usage.map((u) => u.job), `run ${run.runId} is charged once per call`).toEqual(CALLS_PER_RUN);
      expect(usage.reduce((sum, u) => sum + u.costMicros, 0)).toBe(run.costMicros);
    }
    expect((await budgetRepo().get(roomId, new Date())).spentMicros).toBe(costs.reduce((sum, r) => sum + r.costMicros, 0));

    for (const s of all) {
      expect(s.frames.filter(({ frame }) => frame.type === "error" || (frame.type === "ack" && !frame.ok))).toEqual([]);
    }

    const sendToDone = [...threads].map(([requestId, threadId]) =>
      all[0]!.frames.find(({ frame }) => isDone(frame, threadId))!.atMs - sentAt.get(requestId)!);
    const fanOutLag = all.flatMap((s) => [...threads.values()].map((t) => {
      const { frame, atMs } = s.frames.find(({ frame }) => isDone(frame, t))!;
      return atMs - Date.parse(frame.thread.endedAt);
    }));
    console.log(
      `load: ${RUNS} runs, ${all.length} sockets; send→done p50 ${percentile(sendToDone, 50)} ms, p95 ${percentile(sendToDone, 95)} ms;`
      + ` fan-out lag p95 ${percentile(fanOutLag, 95)} ms; all done in ${Date.now() - t0} ms`,
    );
  });
});
