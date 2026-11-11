import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { issueTicket, consumeTicket } from "./tickets.js";
import { isOnline } from "./presence.js";
import { broadcastToRoom, sendToUser } from "./broadcast.js";
import { subscribe } from "./connections.js";

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

  it("sendToUser reaches every tab the user has open", async () => {
    const u = user("tabs");
    const [a, b] = await Promise.all([signIn(u), signIn(u)]);
    await sendToUser(u.userId, { type: "read", roomId: "r", chatId: "c", lastReadSeq: 7 });
    await Promise.all([a.next((f) => f.lastReadSeq === 7), b.next((f) => f.lastReadSeq === 7)]);
  });
});
