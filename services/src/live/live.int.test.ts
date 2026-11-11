import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { budgetRepo } from "../budget/repo.js";
import { threadsRepo } from "../threads/repo.js";
import { presignUpload } from "../chat/files.js";
import { PICK_REFUSED } from "../models/privacy.js";
import { issueTicket, consumeTicket } from "./tickets.js";
import { isOnline } from "./presence.js";
import { broadcastToRoom, sendToConnection, sendToUser } from "./broadcast.js";
import { getConnection, saveConnection, subscribe } from "./connections.js";

// Runs against the deployed stack on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
const wsUrl: string = outputs["cl-local-core"].WsUrl;
process.env.WS_CALLBACK_URL = wsUrl.replace(/^ws/, "http");

const repo = roomsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = Record<string, unknown>;
interface Socket { ws: WebSocket; frames: Frame[]; next(match: (f: Frame) => boolean, ms?: number): Promise<Frame> }

const open: WebSocket[] = [];
afterEach(() => { for (const ws of open.splice(0)) ws.terminate(); });

/** Opens a socket and records every frame it receives, so a frame that arrives before anyone waits isn't lost. */
function connect(ticket: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?ticket=${ticket}`);
    open.push(ws);
    const frames: Frame[] = [];
    const waiters: (() => void)[] = [];
    ws.on("message", (data) => { frames.push(JSON.parse(String(data))); waiters.forEach((w) => w()); });
    const next = (match: (f: Frame) => boolean, ms = 10_000) => new Promise<Frame>((res, rej) => {
      const check = () => {
        const f = frames.find(match);
        if (f) { clearTimeout(timer); res(f); }
      };
      const timer = setTimeout(() => rej(new Error(`no matching frame in ${ms} ms; got ${JSON.stringify(frames)}`)), ms);
      waiters.push(check);
      check();
    });
    ws.once("open", () => resolve({ ws, frames, next }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode} on upgrade`)));
    ws.once("error", reject);
  });
}

async function signIn(u: { userId: string; username: string }) {
  const { ticket } = await issueTicket(u);
  return connect(ticket);
}

const send = (s: Socket, frame: Frame) => s.ws.send(JSON.stringify(frame));

/** Uploads a small text file through the presigned form, as a browser would, and returns it as a send attaches it. */
async function uploadFile(roomId: string, userId: string) {
  const name = "notes.txt";
  const form = await presignUpload(roomId, userId, { name, size: 5, type: "text/plain" });
  const data = new FormData();
  for (const [k, v] of Object.entries(form.fields)) data.append(k, v);
  data.append("file", new Blob(["hello"], { type: "text/plain" }));
  const res = await fetch(form.url, { method: "POST", body: data });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return { key: form.key, name, size: 5, type: "text/plain" };
}

describe("tickets on Floci", () => {
  it("a ticket can be used once", async () => {
    const u = user("t");
    const { ticket } = await issueTicket(u);
    expect(await consumeTicket(ticket)).toEqual(u);
    expect(await consumeTicket(ticket)).toBeNull();
  });

  it("an expired ticket is refused", async () => {
    const { ticket } = await issueTicket(user("t"));
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `WSTICKET#${ticket}`, sk: "META" },
      UpdateExpression: "SET expiresAt = :past", ExpressionAttributeValues: { ":past": Math.floor(Date.now() / 1000) - 1 },
    }));
    expect(await consumeTicket(ticket)).toBeNull();
  });
});

describe("live socket on Floci", () => {
  it("refuses a socket without a valid ticket", async () => {
    await expect(connect("not-a-ticket")).rejects.toThrow(/HTTP 4\d\d/);
  });

  it("ping answers pong and marks the user online", async () => {
    const u = user("p");
    const s = await signIn(u);
    send(s, { action: "ping", requestId: "1" });
    await s.next((f) => f.type === "pong");
    const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `USER#${u.userId}`, sk: "PRESENCE" } }));
    expect(isOnline(Item, Math.floor(Date.now() / 1000))).toBe(true);
  });

  it("a message is acked to its sender and reaches room peers within 2 s", async () => {
    const owner = user("owner");
    const b = user("b");
    const { roomId, generalChatId: chatId } = await repo.createRoom(owner, "Messages");
    await repo.acceptInvite((await repo.rotateInvite(roomId, owner.userId)).code, b);
    const o = await signIn(owner);
    const sb = await signIn(b);

    send(o, { action: "send", requestId: "m1", roomId, chatId, clientId: "k1", text: "hello" });
    const ack = await o.next((f) => f.type === "ack" && f.requestId === "m1");
    expect(ack).toMatchObject({ ok: true, data: { seq: 1, text: "hello", clientId: "k1" } });
    const event = await sb.next((f) => f.type === "message.new", 2000);
    expect(event.message).toMatchObject({ roomId, chatId, seq: 1, text: "hello", authorId: owner.userId });
  });

  it("a removed member's open socket gets no more messages, and its own sends are refused", async () => {
    const owner = user("owner");
    const b = user("b");
    const { roomId, generalChatId: chatId } = await repo.createRoom(owner, "Removal");
    await repo.acceptInvite((await repo.rotateInvite(roomId, owner.userId)).code, b);
    const o = await signIn(owner);
    const sb = await signIn(b);
    await repo.removeMember(roomId, owner.userId, b.userId);

    send(o, { action: "send", requestId: "m1", roomId, chatId, clientId: "k1", text: "after" });
    await o.next((f) => f.type === "message.new");
    await sleep(500);
    expect(sb.frames.some((f) => f.type === "message.new")).toBe(false);

    send(sb, { action: "send", requestId: "m2", roomId, chatId, clientId: "k2", text: "still here?" });
    expect(await sb.next((f) => f.type === "ack")).toMatchObject({ requestId: "m2", ok: false, error: expect.any(String) });
    send(sb, { action: "react", requestId: "m3", roomId, chatId, seq: 1, reaction: "thumbs", on: true });
    expect(await sb.next((f) => f.type === "ack" && f.requestId === "m3")).toMatchObject({ ok: false });
    send(sb, { action: "typing", requestId: "m4", roomId, chatId });
    expect(await sb.next((f) => f.type === "ack" && f.requestId === "m4")).toMatchObject({ ok: false });
    await sleep(500);
    expect(o.frames.some((f) => f.type === "typing")).toBe(false);
  });

  it("an unknown action is a failed ack", async () => {
    const s = await signIn(user("a"));
    send(s, { action: "shout", requestId: "r1" });
    expect(await s.next((f) => f.type === "ack")).toMatchObject({ requestId: "r1", ok: false });
  });

  it("room peers see each other come online and go offline", async () => {
    const owner = user("owner");
    const b = user("b");
    const { roomId } = await repo.createRoom(owner, "Presence");
    await repo.acceptInvite((await repo.rotateInvite(roomId, owner.userId)).code, b);
    const o = await signIn(owner);
    const sb = await signIn(b);
    expect(await o.next((f) => f.type === "presence" && f.userId === b.userId)).toMatchObject({ online: true });
    sb.ws.close();
    await o.next((f) => f.type === "presence" && f.userId === b.userId && f.online === false);
  });

  it("room events reach current members only: a removed member's open socket stops getting them", async () => {
    const owner = user("owner");
    const b = user("b");
    const { roomId } = await repo.createRoom(owner, "Fan-out");
    await repo.acceptInvite((await repo.rotateInvite(roomId, owner.userId)).code, b);
    const o = await signIn(owner);
    const sb = await signIn(b);

    await broadcastToRoom(roomId, { type: "room.updated", roomId, n: 1 });
    await Promise.all([o.next((f) => f.n === 1), sb.next((f) => f.n === 1)]);

    await repo.removeMember(roomId, owner.userId, b.userId);
    await broadcastToRoom(roomId, { type: "room.updated", roomId, n: 2 });
    await o.next((f) => f.n === 2);
    await sleep(500);
    expect(sb.frames.some((f) => f.n === 2)).toBe(false);
  });

  it("subscribe {roomId} picks up a room joined after connecting, at once", async () => {
    const owner = user("owner");
    const u = user("late");
    const { roomId } = await repo.createRoom(owner, "Joined later");
    const s = await signIn(u);
    await repo.acceptInvite((await repo.rotateInvite(roomId, owner.userId)).code, u);
    send(s, { action: "subscribe", requestId: "s1", roomId });
    expect(await s.next((f) => f.type === "ack")).toMatchObject({ type: "ack", requestId: "s1", ok: true });
    await broadcastToRoom(roomId, { type: "room.updated", roomId });
    await s.next((f) => f.type === "room.updated" && f.roomId === roomId);
  });

  it("subscribe to a room you're not in is refused", async () => {
    const { roomId } = await repo.createRoom(user("owner"), "Not yours");
    const s = await signIn(user("outsider"));
    send(s, { action: "subscribe", requestId: "s1", roomId });
    expect(await s.next((f) => f.type === "ack")).toMatchObject({ requestId: "s1", ok: false });
  });

  it("a subscribe for a socket that's already gone writes nothing, so it can't be counted off twice", async () => {
    const connId = `gone-${randomUUID()}`;
    await subscribe(connId, "u-gone", "r-gone");
    const read = (pk: string, sk: string) => docClient().send(new GetCommand({ TableName: tableName(), Key: { pk, sk }, ConsistentRead: true }));
    expect((await read(`CONN#${connId}`, "META")).Item).toBeUndefined();
    expect((await read("ROOM#r-gone", `CONN#${connId}`)).Item).toBeUndefined();
  });

  it("a post that answers Gone right after $connect keeps the socket, since it may still be opening; later, it's cleaned up", async () => {
    // Connection ids API Gateway doesn't know, so every post to them answers Gone.
    const [opening, closed] = [`opening-${randomUUID()}`, `closed-${randomUUID()}`];
    const owner = user("ann");
    await saveConnection(opening, owner, ["r-opening"]);
    await saveConnection(closed, owner, ["r-opening"]);
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `CONN#${closed}`, sk: "META" }, UpdateExpression: "SET connectedAt = :t",
      ExpressionAttributeValues: { ":t": Date.now() - 60_000 },
    }));
    await sendToConnection(opening, { type: "pong" });
    await sendToConnection(closed, { type: "pong" });
    expect(await getConnection(opening)).toBeDefined();
    expect(await getConnection(closed)).toBeUndefined();
  });

  it("sendToUser reaches every tab the user has open", async () => {
    const u = user("tabs");
    const [a, b] = await Promise.all([signIn(u), signIn(u)]);
    await sendToUser(u.userId, { type: "read", roomId: "r", chatId: "c", lastReadSeq: 7 });
    await Promise.all([a.next((f) => f.lastReadSeq === 7), b.next((f) => f.lastReadSeq === 7)]);
  });
});

describe("agent threads over the socket", () => {
  const AGENT_MS = 60_000;

  /** A room with two members on open sockets. */
  async function pair(name: string) {
    const a = user("a");
    const b = user("b");
    const { roomId, generalChatId } = await repo.createRoom(a, name);
    await repo.acceptInvite((await repo.rotateInvite(roomId, a.userId)).code, b);
    return { a, b, roomId, generalChatId, sa: await signIn(a), sb: await signIn(b) };
  }

  const messageUpdated = (chatId: string, seq: number) => (f: Frame) =>
    f.type === "message.updated" && (f.message as Frame).chatId === chatId && (f.message as Frame).seq === seq;
  const runUpdated = (threadId: string, status?: string) => (f: Frame) =>
    f.type === "run.updated" && (f.thread as Frame).threadId === threadId && (!status || (f.thread as Frame).status === status);
  const history = async (u: { userId: string; username: string }, roomId: string, chatId: string) =>
    (await chatRepo().history(u, roomId, chatId, {})).messages;

  it("@agent in a people chat starts a thread and turns the message into its card", async () => {
    const { a, roomId, generalChatId, sa, sb } = await pair("Cards");
    send(sa, { action: "send", requestId: "c1", roomId, chatId: generalChatId, clientId: "k1", text: "@agent look tools:1" });
    expect(await sa.next((f) => f.type === "ack")).toMatchObject({ ok: true, data: { seq: 1, text: "@agent look tools:1" } });

    const updated = await sb.next(messageUpdated(generalChatId, 1));
    const ref = (updated.message as Frame).threadRef as Frame;
    expect(ref.kind).toBe("started");
    // Linking bumps the version, so a stale copy of the plain message (a gap catch-up, say) can't replace the card.
    expect((updated.message as Frame).v).toBe(1);
    const threadId = String(ref.threadId);
    await sb.next(runUpdated(threadId, "done"), AGENT_MS);

    const isNew = (f: Frame) => f.type === "message.new" && (f.message as Frame).chatId === generalChatId;
    expect(sb.frames.findIndex(isNew)).toBeLessThan(sb.frames.indexOf(updated));
    // The room knows the thread before the card that points at it.
    expect(sb.frames.findIndex(runUpdated(threadId))).toBeLessThan(sb.frames.indexOf(updated));
    expect(sb.frames.filter(runUpdated(threadId)).at(-1)).toMatchObject({ thread: { status: "done", number: 1 } });
    expect(await history(a, roomId, generalChatId)).toHaveLength(1);
    const [first, answer] = await history(a, roomId, threadId);
    expect(first).toMatchObject({ authorId: a.userId, text: "@agent look tools:1" });
    expect(answer).toMatchObject({ authorId: "agent", agent: { status: "done" } });
  }, AGENT_MS);

  it("a leading #tag or a threadId delivers a people-chat message into the thread, which starts a run", async () => {
    const { a, roomId, generalChatId, sa, sb } = await pair("Delivery");
    const { thread } = await threadsRepo().createThread(a, roomId, { text: "notes", clientId: "k0" });

    send(sa, { action: "send", requestId: "d1", roomId, chatId: generalChatId, clientId: "k1", text: "#1 and this" });
    const updated = await sb.next(messageUpdated(generalChatId, 1));
    expect((updated.message as Frame).threadRef).toEqual({ threadId: thread.threadId, kind: "delivered" });
    const running = await sb.next((f) => runUpdated(thread.threadId)(f) && (f.thread as Frame).runFirstSeq === 2);
    expect((await history(a, roomId, thread.threadId))[1]).toMatchObject({ seq: 2, authorId: a.userId, clientId: "k1:t", text: "#1 and this" });
    await sb.next((f) => runUpdated(thread.threadId, "done")(f) && (f.thread as Frame).runId === (running.thread as Frame).runId, AGENT_MS);

    send(sa, { action: "send", requestId: "d2", roomId, chatId: generalChatId, threadId: thread.threadId, clientId: "k2", text: "and more" });
    expect((await sb.next(messageUpdated(generalChatId, 2))).message).toMatchObject({ threadRef: { kind: "delivered" } });
    const copies = await history(a, roomId, thread.threadId);
    expect(copies.filter((m) => m.authorId === a.userId).map((m) => m.text)).toEqual(["notes", "#1 and this", "and more"]);
  }, AGENT_MS);

  it("a mention counts once: the copy in the thread doesn't badge the member again", async () => {
    const { a, b, roomId, generalChatId, sa } = await pair("Mentions");
    send(sa, { action: "send", requestId: "m1", roomId, chatId: generalChatId, clientId: "k1", text: "@agent ask @b tools:0" });
    const started = await sa.next(messageUpdated(generalChatId, 1));
    const threadId = String(((started.message as Frame).threadRef as Frame).threadId);
    send(sa, { action: "send", requestId: "m2", roomId, chatId: generalChatId, clientId: "k2", text: "#1 and @b again" });
    await sa.next(messageUpdated(generalChatId, 2));

    const item = async (sk: string) =>
      (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk }, ConsistentRead: true }))).Item;
    expect(await item(`MEMBER#${b.userId}`)).toMatchObject({ mentions: 2 });
    expect((await item(`READ#${b.userId}#${threadId}`))?.mentions).toBeUndefined();
    expect((await history(a, roomId, threadId)).filter((m) => m.authorId === a.userId).map((m) => m.mentions))
      .toEqual([[b.userId], [b.userId]]);
  }, AGENT_MS);

  it("a thread's #name is sent as its #number; a tag later in the text delivers nothing", async () => {
    const { a, roomId, generalChatId, sa } = await pair("Tags");
    const { thread } = await threadsRepo().createThread(a, roomId, { text: "notes", clientId: "k0" });
    await threadsRepo().rename(a, roomId, thread.threadId, "pr-check");

    send(sa, { action: "send", requestId: "t1", roomId, chatId: generalChatId, clientId: "k1", text: "see #pr-check and #general" });
    expect(await sa.next((f) => f.type === "ack")).toMatchObject({ ok: true, data: { text: "see #1 and #general" } });
    await sleep(1000);
    expect(sa.frames.some(messageUpdated(generalChatId, 1))).toBe(false);
  });

  it("a message in a thread chat starts the thread's run", async () => {
    const { a, roomId, sa, sb } = await pair("Thread chat");
    const { thread } = await threadsRepo().createThread(a, roomId, { text: "notes", clientId: "k0" });
    send(sa, { action: "send", requestId: "s1", roomId, chatId: thread.threadId, clientId: "k1", text: "go tools:0" });
    await sb.next((f) => runUpdated(thread.threadId, "running")(f) && (f.thread as Frame).runFirstSeq === 2);
    await sb.next(runUpdated(thread.threadId, "done"), AGENT_MS);
  }, AGENT_MS);

  it("a file makes a thread private, and a DeepSeek pick there is refused before anything is stored", async () => {
    const { a, roomId, sa, sb } = await pair("Private");
    const { thread } = await threadsRepo().createThread(a, roomId, { text: "notes", clientId: "k0" });
    const file = await uploadFile(roomId, a.userId);
    send(sa, { action: "send", requestId: "p1", roomId, chatId: thread.threadId, clientId: "k1", text: "read this tools:0", attachments: [file] });
    expect(await sa.next((f) => f.type === "ack" && f.requestId === "p1")).toMatchObject({ ok: true });
    const done = await sb.next(runUpdated(thread.threadId, "done"), AGENT_MS);
    expect((done.thread as Frame).taint).toEqual(["attachment"]);
    const before = (await history(a, roomId, thread.threadId)).length;

    send(sa, { action: "send", requestId: "p2", roomId, chatId: thread.threadId, clientId: "k2", text: "again", model: "deepseek-flash" });
    expect(await sa.next((f) => f.type === "ack" && f.requestId === "p2")).toMatchObject({ ok: false, error: PICK_REFUSED });
    expect(await history(a, roomId, thread.threadId)).toHaveLength(before);
  }, AGENT_MS);

  it("@agent with a file: DeepSeek is refused with no thread or message; Sonnet starts a private thread", async () => {
    const { a, roomId, generalChatId, sa, sb } = await pair("Private start");
    const file = await uploadFile(roomId, a.userId);
    const ask = { action: "send", roomId, chatId: generalChatId, text: "@agent look tools:0", attachments: [file] };

    send(sa, { ...ask, requestId: "q1", clientId: "k1", model: "deepseek-pro" });
    expect(await sa.next((f) => f.type === "ack" && f.requestId === "q1")).toMatchObject({ ok: false, error: PICK_REFUSED });
    expect(await history(a, roomId, generalChatId)).toHaveLength(0);
    expect((await repo.getRoomView(roomId, a.userId)).threads).toEqual([]);

    send(sa, { ...ask, requestId: "q2", clientId: "k2", model: "sonnet" });
    expect(await sa.next((f) => f.type === "ack" && f.requestId === "q2")).toMatchObject({ ok: true });
    const updated = await sb.next(messageUpdated(generalChatId, 1));
    const threadId = String(((updated.message as Frame).threadRef as Frame).threadId);
    await sb.next(runUpdated(threadId, "done"), AGENT_MS);
    expect((await threadsRepo().threadById(roomId, threadId))!.taint).toEqual(["attachment"]);
  }, AGENT_MS);

  /** A slow run that A starts from #general; resolves with its thread id once the card is in place. */
  async function slowRun(at: Awaited<ReturnType<typeof pair>>) {
    send(at.sa, { action: "send", requestId: "slow", roomId: at.roomId, chatId: at.generalChatId, clientId: "k1", text: "@agent slow words:400" });
    const updated = await at.sa.next(messageUpdated(at.generalChatId, 1));
    const threadId = String(((updated.message as Frame).threadRef as Frame).threadId);
    await at.sa.next(runUpdated(threadId, "running"));
    return threadId;
  }

  it("any member can stop a run", async () => {
    const at = await pair("Stop");
    const threadId = await slowRun(at);
    send(at.sb, { action: "stop", requestId: "x1", roomId: at.roomId, threadId });
    const ack = await at.sb.next((f) => f.type === "ack" && f.requestId === "x1");
    expect(ack).toMatchObject({ ok: true, data: { runId: expect.any(String) } });
    await at.sb.next(runUpdated(threadId, "stopped"), AGENT_MS);
  }, AGENT_MS);

  it("the owner's budget change reaches the room at once", async () => {
    const { a, roomId, sb } = await pair("Budget");
    const budget = await budgetRepo().setCap(a, roomId, 5_000_000);
    expect(await sb.next((f) => f.type === "budget.updated")).toEqual({ type: "budget.updated", roomId, budget });
    expect(budget).toMatchObject({ capMicros: 5_000_000, spentMicros: 0 });
  });

  it("a removed member can't stop a run", async () => {
    const at = await pair("Stop removed");
    const threadId = await slowRun(at);
    await repo.removeMember(at.roomId, at.a.userId, at.b.userId);
    send(at.sb, { action: "stop", requestId: "x1", roomId: at.roomId, threadId });
    expect(await at.sb.next((f) => f.type === "ack" && f.requestId === "x1")).toMatchObject({ ok: false, error: expect.any(String) });
    expect((await threadsRepo().threadById(at.roomId, threadId))!.status).toBe("running");

    send(at.sa, { action: "stop", requestId: "x2", roomId: at.roomId, threadId });
    await at.sa.next(runUpdated(threadId, "stopped"), AGENT_MS);
  }, AGENT_MS);
});
