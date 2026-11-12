import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { Conflict, Forbidden, Gone, NotFound } from "../lib/errors.js";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { searchRoom } from "../chat/search.js";
import { RATE_PER_MIN } from "../chat/model.js";
import { budgetRepo } from "../budget/repo.js";
import { monthKey } from "../budget/model.js";
import { threadSk } from "./model.js";
import { threadsRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const rooms = roomsRepo();
const threads = threadsRepo();
const budget = budgetRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });

let clients = 0;
const start = (u: ReturnType<typeof user>, roomId: string, text = "look into this") =>
  threads.createThread(u, roomId, { text, clientId: `k${++clients}` });

const get = async (pk: string, sk: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk, sk }, ConsistentRead: true }))).Item;

/** Every thread item, thread chat and name guard for the room, wherever it lives in the table. */
async function threadItemsOf(roomId: string) {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await docClient().send(new ScanCommand({
      TableName: tableName(), ExclusiveStartKey, ConsistentRead: true,
      FilterExpression: "(pk = :room AND (begins_with(sk, :thread) OR begins_with(sk, :name))) OR (roomId = :r AND #kind = :kind)",
      ExpressionAttributeNames: { "#kind": "kind" },
      ExpressionAttributeValues: { ":room": `ROOM#${roomId}`, ":thread": "THREAD#", ":name": "CHATNAME#thread-", ":r": roomId, ":kind": "thread" },
    }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function room() {
  const owner = user("owner");
  const { roomId } = await rooms.createRoom(owner, "Agents");
  return { owner, roomId };
}

describe("threads repo on Floci", () => {
  it("5 concurrent creates get #1 to #5, gapless, with provisional names and the first message in each thread", async () => {
    const { owner, roomId } = await room();
    const made = await Promise.all(Array.from({ length: 5 }, (_, i) => start(owner, roomId, `task ${i}`)));
    const numbers = made.map((m) => m.thread.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    for (const { thread, message } of made) {
      expect(thread).toMatchObject({ roomId, name: `thread-${thread.number}`, status: "idle", rev: 1, steps: 0, costMicros: 0, archived: false });
      expect(message).toMatchObject({ chatId: thread.threadId, seq: 1, authorId: owner.userId });
      const { messages } = await chatRepo().history(owner, roomId, thread.threadId, {});
      expect(messages.map((m) => m.text)).toEqual([message.text]);
    }
  });

  it("rename: unique per room, shared with chat names, and a renamed thread takes no suggestion", async () => {
    const { owner, roomId } = await room();
    const [first, second, third] = [await start(owner, roomId), await start(owner, roomId), await start(owner, roomId)];
    const renamed = await threads.rename(owner, roomId, first.thread.threadId, "pr-check");
    expect(renamed).toMatchObject({ name: "pr-check", rev: 2 });

    await expect(threads.rename(owner, roomId, second.thread.threadId, "pr-check")).rejects.toThrow(new Conflict("#pr-check is taken."));
    await expect(threads.rename(owner, roomId, second.thread.threadId, "general")).rejects.toBeInstanceOf(Conflict);
    await expect(rooms.createChat(roomId, owner.userId, "pr-check")).rejects.toBeInstanceOf(Conflict);
    await expect(rooms.createChat(roomId, owner.userId, "thread-9")).rejects.toThrow(/numbered threads/);

    expect(await threads.nameIfProvisional(roomId, third.thread.threadId, "pr-check")).toMatchObject({ name: "pr-check-2" });
    expect(await threads.nameIfProvisional(roomId, first.thread.threadId, "other")).toBeNull();
    // A name is free again once its thread moves off it.
    await threads.rename(owner, roomId, first.thread.threadId, "pr-review");
    expect(await threads.rename(owner, roomId, second.thread.threadId, "pr-check")).toMatchObject({ name: "pr-check" });
    // Any member renames, not only admins.
    const member = user("member");
    await rooms.acceptInvite((await rooms.rotateInvite(roomId, owner.userId)).code, member);
    expect(await threads.rename(member, roomId, third.thread.threadId, "by-member")).toMatchObject({ name: "by-member" });
  });

  it("tags resolve by number or by a thread's name; a chat's name is no thread", async () => {
    const { owner, roomId } = await room();
    await start(owner, roomId);
    const { thread } = await start(owner, roomId);
    await threads.rename(owner, roomId, thread.threadId, "pr-check");
    expect(await threads.threadByTag(roomId, { number: 2 })).toMatchObject({ threadId: thread.threadId });
    expect(await threads.threadByTag(roomId, { name: "pr-check" })).toMatchObject({ threadId: thread.threadId, number: 2 });
    expect(await threads.threadByTag(roomId, { name: "general" })).toBeNull();
    expect(await threads.threadByTag(roomId, { number: 9 })).toBeNull();
  });

  it("threadById refuses a thread from another room", async () => {
    const a = await room();
    const b = await room();
    const { thread } = await start(a.owner, a.roomId);
    expect(await threads.threadById(a.roomId, thread.threadId)).toMatchObject({ number: 1 });
    expect(await threads.threadById(b.roomId, thread.threadId)).toBeNull();
  });

  it("the room view lists threads, archiving one idle for 8 days, and carries the month's budget", async () => {
    const { owner, roomId } = await room();
    const { thread: quiet } = await start(owner, roomId);
    await start(owner, roomId);
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(quiet.number) }, UpdateExpression: "SET lastActivityAt = :t",
      ExpressionAttributeValues: { ":t": new Date(Date.now() - 8 * 86_400_000).toISOString() },
    }));
    const view = await rooms.getRoomView(roomId, owner.userId);
    expect(view.threads.map((t) => [t.number, t.archived])).toEqual([[1, true], [2, false]]);
    expect(view.threads[0]).not.toHaveProperty("named");
    expect(view.chats.map((c) => c.name)).toEqual(["general"]);
    expect(view.budget).toMatchObject({ spentMicros: 0, capMicros: 3_000_000, month: monthKey(new Date()) });
  });

  it("search finds a thread's messages", async () => {
    const { owner, roomId } = await room();
    const { thread } = await start(owner, roomId, "check the flaky pipeline");
    const { results } = await searchRoom(owner, roomId, "flaky");
    expect(results).toEqual([expect.objectContaining({ chatId: thread.threadId, seq: 1 })]);
  });

  it("budget: usage adds up under the UTC month; only the owner sets the cap", async () => {
    const { owner, roomId } = await room();
    const now = new Date();
    const spend = (costMicros: number) => docClient().send(new TransactWriteCommand({ TransactItems: [budget.spend(roomId, costMicros, now)] }));
    await spend(1_250);
    await spend(3_000);
    expect(await budget.get(roomId, now)).toMatchObject({ spentMicros: 4_250, capMicros: 3_000_000, month: monthKey(now) });
    const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: `USAGE#${monthKey(now)}` }, ConsistentRead: true }));
    expect(Item).toMatchObject({ costMicros: 4_250, calls: 2 });

    const admin = user("admin");
    await rooms.acceptInvite((await rooms.rotateInvite(roomId, owner.userId)).code, admin);
    await rooms.setRole(roomId, owner.userId, admin.userId, "admin");
    await expect(budget.setCap(admin, roomId, 1_000_000)).rejects.toBeInstanceOf(Forbidden);
    expect(await budget.setCap(owner, roomId, 5_000_000)).toMatchObject({ capMicros: 5_000_000, spentMicros: 4_250 });
    expect(await budget.get(roomId, now)).toMatchObject({ capMicros: 5_000_000 });
  });

  it("a refused first message writes nothing: no thread, chat, guard or number", async () => {
    const { owner, roomId } = await room();
    // Fill this minute's and the next one's rate windows, so the test can't straddle a fresh window.
    const minute = Math.floor(Date.now() / 60_000);
    for (const m of [minute, minute + 1]) {
      await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `RATE#${owner.userId}`, sk: String(m), n: RATE_PER_MIN } }));
    }
    await expect(start(owner, roomId)).rejects.toThrow(/Slow down/);
    expect(await threadItemsOf(roomId)).toEqual([]);
    expect((await get(`ROOM#${roomId}`, "META"))?.threadSeq).toBeUndefined();
  });

  it("a chat already holding a thread's provisional name refuses that create with a Conflict; the next number works", async () => {
    const { owner, roomId } = await room();
    await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: `ROOM#${roomId}`, sk: "CHATNAME#thread-1", chatId: "legacy" } }));
    await expect(start(owner, roomId)).rejects.toThrow(new Conflict("#thread-1 is already a chat's name; try again."));
    expect((await start(owner, roomId)).thread).toMatchObject({ number: 2, name: "thread-2" });
  });

  it("a suggestion never renames a thread marked named, even one still called thread-N", async () => {
    const { owner, roomId } = await room();
    const { thread } = await start(owner, roomId);
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: threadSk(1) }, UpdateExpression: "SET #named = :t",
      ExpressionAttributeNames: { "#named": "named" }, ExpressionAttributeValues: { ":t": true },
    }));
    expect(await threads.nameIfProvisional(roomId, thread.threadId, "pr-check")).toBeNull();
    expect(await threads.threadById(roomId, thread.threadId)).toMatchObject({ name: "thread-1" });
  });

  it("an archived room takes no new threads and no new cap", async () => {
    const { owner, roomId } = await room();
    await rooms.archiveRoom(roomId, owner.userId);
    await expect(start(owner, roomId)).rejects.toBeInstanceOf(Gone);
    await expect(budget.setCap(owner, roomId, 1_000_000)).rejects.toBeInstanceOf(Gone);
  });

  it("a non-member can't start a thread", async () => {
    const { roomId } = await room();
    await expect(start(user("stranger"), roomId)).rejects.toBeInstanceOf(NotFound);
  });
});
