import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { Conflict, Forbidden, Gone, NotFound, ValidationError } from "../rooms/model.js";
import { chatRepo } from "./repo.js";
import { seqKey } from "./model.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const rooms = roomsRepo();
const chat = chatRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type User = ReturnType<typeof user>;

/** A fresh room: its owner plus one member per name, joined through the invite link. */
async function room(...names: string[]) {
  const owner = user("owner");
  const { roomId, generalChatId: chatId } = await rooms.createRoom(owner, "Chat");
  const { code } = await rooms.rotateInvite(roomId, owner.userId);
  const members = names.map(user);
  for (const m of members) await rooms.acceptInvite(code, m);
  return { owner, members, roomId, chatId, at: { roomId, chatId } };
}

let clients = 0;
const say = (u: User, at: { roomId: string; chatId: string }, text = "hi") =>
  chat.send(u, { ...at, clientId: `k${++clients}`, text });

const item = async (pk: string, sk: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk, sk }, ConsistentRead: true }))).Item;

describe("chat repo on Floci", () => {
  it("send allocates seq 1, 2, 3 in order; history after=1 returns 2 and 3", async () => {
    const { owner, at } = await room();
    const sent = [await say(owner, at, "one"), await say(owner, at, "two"), await say(owner, at, "three")];
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(sent[0]).toMatchObject({ authorId: owner.userId, authorName: "owner", text: "one", reactions: {}, attachments: [] });
    const { messages } = await chat.history(owner, at.roomId, at.chatId, { after: 1 });
    expect(messages.map((m) => [m.seq, m.text])).toEqual([[2, "two"], [3, "three"]]);
    expect(messages[0]).not.toHaveProperty("textLower");
  });

  it("10 concurrent sends get 10 distinct, gapless seqs", async () => {
    const { owner, at } = await room();
    const sent = await Promise.all(Array.from({ length: 10 }, (_, i) => say(owner, at, `m${i}`)));
    expect(sent.map((m) => m.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("history pages: newest 50 by default, before, and 25 either side of around", async () => {
    const { owner, members: [b], at } = await room("bee");
    // Two authors, so 60 messages stay inside the per-user rate limit.
    for (let i = 0; i < 60; i++) await say(i % 2 ? b : owner, at, `m${i + 1}`);
    const seqs = async (cursor: Parameters<typeof chat.history>[3]) =>
      (await chat.history(owner, at.roomId, at.chatId, cursor)).messages.map((m) => m.seq);
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    expect(await seqs({})).toEqual(range(11, 60));
    expect(await seqs({ before: 11 })).toEqual(range(1, 10));
    expect(await seqs({ around: 30 })).toEqual(range(5, 54));
  }, 60_000);

  it("the 31st send in one minute is refused", async () => {
    const { owner, at } = await room();
    // The window is the calendar minute, so don't start a burst that would straddle two of them.
    if (Date.now() % 60_000 > 50_000) await sleep(60_000 - (Date.now() % 60_000) + 200);
    const results = await Promise.allSettled(Array.from({ length: 31 }, () => say(owner, at)));
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(Conflict);
    expect(refused[0].reason.message).toBe("Slow down: 30 messages a minute.");
    const { messages } = await chat.history(owner, at.roomId, at.chatId, {});
    expect(messages.map((m) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  }, 60_000);

  it("empty text with no attachments is refused", async () => {
    const { owner, at } = await room();
    await expect(say(owner, at, "   ")).rejects.toBeInstanceOf(ValidationError);
  });

  it("a quote-reply carries the quoted author and an excerpt", async () => {
    const { owner, members: [b], at } = await room("bee");
    const first = await say(owner, at, "the original");
    const reply = await chat.send(b, { ...at, clientId: "r1", text: "agreed", replyToSeq: first.seq });
    expect(reply.replyTo).toEqual({ seq: first.seq, authorName: "owner", excerpt: "the original" });
  });

  it("edit: the author within 15 minutes only; each edit keeps the old text as a version", async () => {
    const { owner, members: [b], at } = await room("bee");
    const m = await say(owner, at, "first");
    await expect(chat.edit(b, { ...at, seq: m.seq, text: "hacked" })).rejects.toBeInstanceOf(Forbidden);

    const edited = await chat.edit(owner, { ...at, seq: m.seq, text: "Second" });
    expect(edited).toMatchObject({ seq: m.seq, text: "Second", editedAt: expect.any(String) });
    const stored = await item(`CHAT#${at.chatId}`, seqKey(m.seq));
    expect(stored).toMatchObject({ text: "Second", textLower: "second" });
    const { Items: versions = [] } = await docClient().send(new QueryCommand({
      TableName: tableName(), KeyConditionExpression: "pk = :p AND begins_with(sk, :v)",
      ExpressionAttributeValues: { ":p": `CHAT#${at.chatId}`, ":v": "VER#" },
    }));
    expect(versions.map((v) => v.text)).toEqual(["first"]);

    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `CHAT#${at.chatId}`, sk: seqKey(m.seq) },
      UpdateExpression: "SET createdAt = :old", ExpressionAttributeValues: { ":old": new Date(Date.now() - 16 * 60_000).toISOString() },
    }));
    await expect(chat.edit(owner, { ...at, seq: m.seq, text: "too late" })).rejects.toBeInstanceOf(Forbidden);
  });

  it("an admin removes a member's message: readers get no text, the table keeps it", async () => {
    const { owner, members: [admin, b], at } = await room("admin", "bee");
    await rooms.setRole(at.roomId, owner.userId, admin.userId, "admin");
    const m = await say(b, at, "regrettable");
    const removed = await chat.remove(admin, { ...at, seq: m.seq });
    expect(removed).toMatchObject({ seq: m.seq, deleted: "admin", text: "" });
    const { messages } = await chat.history(b, at.roomId, at.chatId, {});
    expect(messages[0]).toMatchObject({ deleted: "admin", text: "" });
    expect(await item(`CHAT#${at.chatId}`, seqKey(m.seq))).toMatchObject({ text: "regrettable", deleted: "admin" });
    await expect(chat.remove(admin, { ...at, seq: m.seq })).rejects.toBeInstanceOf(Conflict);
    await expect(chat.edit(b, { ...at, seq: m.seq, text: "back" })).rejects.toBeInstanceOf(Forbidden);
  });

  it("a member can't remove someone else's message, but can remove their own", async () => {
    const { owner, members: [b], at } = await room("bee");
    const theirs = await say(owner, at);
    await expect(chat.remove(b, { ...at, seq: theirs.seq })).rejects.toBeInstanceOf(Forbidden);
    const mine = await say(b, at);
    expect(await chat.remove(b, { ...at, seq: mine.seq })).toMatchObject({ deleted: "self" });
  });

  it("react on then off leaves no thumbs entry", async () => {
    const { owner, members: [b], at } = await room("bee");
    const m = await say(owner, at);
    const on = await chat.react(b, { ...at, seq: m.seq, reaction: "thumbs", on: true });
    expect(on.reactions).toEqual({ thumbs: [b.userId] });
    const off = await chat.react(b, { ...at, seq: m.seq, reaction: "thumbs", on: false });
    expect(off.reactions).toEqual({});
    expect((await item(`CHAT#${at.chatId}`, seqKey(m.seq)))?.reactions).not.toHaveProperty("thumbs");
  });

  it("a mention counts on the target's read state and membership; markRead clears both", async () => {
    const { owner, members: [b], roomId, chatId, at } = await room("bee");
    const m = await say(owner, at, "ping @bee");
    expect(m).toMatchObject({ mentions: [b.userId], everyone: false });
    expect(await item(`ROOM#${roomId}`, `READ#${owner.userId}#${chatId}`)).toMatchObject({ lastReadSeq: m.seq });
    expect(await item(`ROOM#${roomId}`, `READ#${b.userId}#${chatId}`)).toMatchObject({ mentions: 1 });
    expect(await item(`ROOM#${roomId}`, `MEMBER#${b.userId}`)).toMatchObject({ mentions: 1 });

    expect(await chat.markRead(b, { ...at, seq: m.seq })).toEqual({ lastReadSeq: m.seq });
    expect(await item(`ROOM#${roomId}`, `READ#${b.userId}#${chatId}`)).toMatchObject({ mentions: 0, lastReadSeq: m.seq });
    expect(await item(`ROOM#${roomId}`, `MEMBER#${b.userId}`)).toMatchObject({ mentions: 0 });
  });

  it("@everyone counts for every member except the sender", async () => {
    const { owner, members: [b, c], roomId, at } = await room("bee", "cee");
    await say(b, at, "@everyone standup");
    expect(await item(`ROOM#${roomId}`, `MEMBER#${owner.userId}`)).toMatchObject({ mentions: 1 });
    expect(await item(`ROOM#${roomId}`, `MEMBER#${c.userId}`)).toMatchObject({ mentions: 1 });
    expect(await item(`ROOM#${roomId}`, `MEMBER#${b.userId}`)).toMatchObject({ mentions: 0 });
  });

  it("a removed member's send is NotFound", async () => {
    const { owner, members: [b], at } = await room("bee");
    await rooms.removeMember(at.roomId, owner.userId, b.userId);
    await expect(say(b, at)).rejects.toBeInstanceOf(NotFound);
  });

  it("a send to an archived room is Gone", async () => {
    const { owner, roomId, at } = await room();
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: `MEMBER#${owner.userId}` },
      UpdateExpression: "SET archived = :t", ExpressionAttributeValues: { ":t": true },
    }));
    await expect(say(owner, at)).rejects.toBeInstanceOf(Gone);
  });

  it("a chat from another room is NotFound, for sends and history alike", async () => {
    const mine = await room();
    const other = await room();
    const elsewhere = { roomId: mine.roomId, chatId: other.chatId };
    await expect(say(mine.owner, elsewhere)).rejects.toBeInstanceOf(NotFound);
    await say(other.owner, other.at, "private");
    await expect(chat.history(mine.owner, mine.roomId, other.chatId, {})).rejects.toBeInstanceOf(NotFound);
  });
});
