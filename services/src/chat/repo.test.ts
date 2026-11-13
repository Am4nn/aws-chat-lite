import { describe, it, expect, vi, afterEach } from "vitest";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { Gone } from "../lib/errors.js";
import { chatRepo } from "./repo.js";

const pushed = vi.hoisted(() => [] as unknown[]);
vi.mock("../push/enqueue.js", () => ({ enqueuePush: async (job: unknown) => void pushed.push(job) }));

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => {
  vi.restoreAllMocks();
  pushed.length = 0;
});

const me = { userId: "u1", username: "ann" };
const at = { roomId: "r1", chatId: "c1" };
const stored = (extra: object = {}) => ({
  ...at, seq: 1, authorId: "u1", authorName: "ann", text: "hi", textLower: "hi", createdAt: new Date().toISOString(),
  attachments: [], reactions: {}, mentions: [], everyone: false, ...extra,
});

/** A member in room r1 whose chat holds message 1; `write` answers (or throws for) every write. */
function fakeTable(message: object, write: (c: unknown) => unknown = () => ({})) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) return { Item: String(c.input.Key?.sk).startsWith("MEMBER#") ? { role: "member" } : message };
    return write(c);
  }) as never);
}

const isRate = (c: unknown) => c instanceof UpdateCommand && String(c.input.Key?.pk).startsWith("RATE#");
/** The writes a test means: rate counters are left out (the rate tests read them on their own). */
const writes = (send: ReturnType<typeof fakeTable>) => send.mock.calls.map(([c]) => c).filter((c) => !(c instanceof GetCommand) && !isRate(c));

describe("history", () => {
  it("reads a smaller or larger page when asked, newest first from before", async () => {
    const send = fakeTable({ roomId: at.roomId, lastSeq: 80 }, () => ({ Items: [] }));
    await chatRepo().history(me, at.roomId, at.chatId, { before: 70, limit: 30 });
    const query = writes(send).find((c) => c instanceof QueryCommand) as QueryCommand;
    expect(query.input).toMatchObject({ Limit: 30, ScanIndexForward: false });
  });
});

describe("message versions", () => {
  it("an edit locks on the version it read and bumps it", async () => {
    const send = fakeTable(stored({ v: 3 }));
    const edited = await chatRepo().edit(me, { ...at, seq: 1, text: "hello" });
    const update = (writes(send)[0] as TransactWriteCommand).input.TransactItems![1].Update!;
    expect(update.UpdateExpression).toContain("ADD v :one");
    expect(update.ConditionExpression).toContain("(attribute_not_exists(v) OR v = :v)");
    expect(update.ExpressionAttributeValues).toMatchObject({ ":v": 3, ":one": 1 });
    expect(edited).toMatchObject({ text: "hello", v: 4 });
  });

  it("a message never changed has no v yet, so an edit locks on its absence", async () => {
    const send = fakeTable(stored());
    expect(await chatRepo().edit(me, { ...at, seq: 1, text: "hello" })).toMatchObject({ v: 1 });
    const update = (writes(send)[0] as TransactWriteCommand).input.TransactItems![1].Update!;
    expect(update.ExpressionAttributeValues).toMatchObject({ ":v": 0 });
  });

  it("a delete returns the message as stored after it, so a reaction racing it can't leave two broadcasts with one version", async () => {
    let written = false;
    vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
      if (c instanceof TransactWriteCommand) return (written = true), {};
      if (String((c as GetCommand).input.Key?.sk).startsWith("MEMBER#")) return { Item: { role: "member" } };
      return { Item: written ? stored({ v: 3, deleted: "self", reactions: { heart: new Set(["u2"]) } }) : stored({ v: 1 }) };
    }) as never);
    const { message } = await chatRepo().remove(me, { ...at, seq: 1 });
    expect(message).toMatchObject({ deleted: "self", v: 3, reactions: { heart: ["u2"] } });
  });

  it("a delete and a reaction each bump the version", async () => {
    const send = fakeTable(stored({ v: 1 }), (c) => ({ Attributes: { ...stored({ v: 2 }), reactions: { thumbs: new Set(["u1"]) } }, c }));
    await chatRepo().remove(me, { ...at, seq: 1 });
    await chatRepo().react(me, { ...at, seq: 1, reaction: "thumbs", on: true });
    const [del, react] = writes(send) as [TransactWriteCommand, UpdateCommand];
    expect(del.input.TransactItems![0]!.Update!.UpdateExpression).toContain("ADD v :one");
    expect(react.input.UpdateExpression).toContain("v :one");
  });

  it("deleting a message also deletes its copy in each thread it went to, in the same transaction", async () => {
    const send = fakeTable(stored({ threadRef: { kind: "delivered", threads: [{ threadId: "t1", seq: 5 }, { threadId: "t2", seq: 7 }] } }));
    const { copies } = await chatRepo().remove(me, { ...at, seq: 1 });
    const [original, inThread, inOther] = (writes(send)[0] as TransactWriteCommand).input.TransactItems!;
    expect(original!.Update).toMatchObject({ Key: { pk: "CHAT#c1", sk: "MSG#0000000001" }, ConditionExpression: "attribute_not_exists(deleted)" });
    expect(inThread!.Update).toMatchObject({
      Key: { pk: "CHAT#t1", sk: "MSG#0000000005" }, UpdateExpression: "SET deleted = if_not_exists(deleted, :d) ADD v :one",
      ConditionExpression: "attribute_exists(sk)", ExpressionAttributeValues: { ":d": "self", ":one": 1 },
    });
    expect(inOther!.Update).toMatchObject({ Key: { pk: "CHAT#t2", sk: "MSG#0000000007" } });
    expect(copies).toHaveLength(2);
  });

  it("deleting a thread's card deletes the thread's first message, and a schedule's card, which has none, nothing more", async () => {
    const send = fakeTable(stored({ threadRef: { kind: "started", threadId: "t1", seq: 1 } }));
    expect((await chatRepo().remove(me, { ...at, seq: 1 })).copies).toHaveLength(1);
    fakeTable(stored({ threadRef: { kind: "started", threadId: "t1" } }));
    expect((await chatRepo().remove(me, { ...at, seq: 1 })).copies).toEqual([]);
    expect((writes(send)[0] as TransactWriteCommand).input.TransactItems![1]!.Update).toMatchObject({ Key: { pk: "CHAT#t1", sk: "MSG#0000000001" } });
  });
});

const conflict = () => Object.assign(new Error("clash"), {
  name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }],
});

describe("transaction conflicts", () => {
  it("markRead tries again after another transaction held its items", async () => {
    let calls = 0;
    const send = fakeTable({ lastReadSeq: 0, mentions: 1 }, (c) => {
      if (c instanceof TransactWriteCommand && calls++ === 0) throw conflict();
      return {};
    });
    expect(await chatRepo().markRead(me, { ...at, seq: 1 })).toEqual({ lastReadSeq: 1 });
    expect(writes(send)).toHaveLength(2);
  });

  it("an edit that clashes with another transaction asks to try again", async () => {
    fakeTable(stored(), (c) => {
      if (c instanceof TransactWriteCommand) throw conflict();
      return {};
    });
    await expect(chatRepo().edit(me, { ...at, seq: 1, text: "hello" })).rejects.toThrow("That message just changed; try again.");
  });
});

describe("mention pushes", () => {
  const bea = { userId: "u2", username: "bea" };
  const cy = { userId: "u3", username: "cy" };
  /** Every write answers as the chat counter does, and a member query lists ann, bea and cy. */
  const roomOfThree = (message: object) => fakeTable(message, (c) => {
    if (c instanceof QueryCommand) return { Items: [me, bea, cy] };
    return { Attributes: { lastSeq: 2 } };
  });

  it("a send tells the members it mentions, never its author", async () => {
    roomOfThree(stored());
    await chatRepo().send(me, { ...at, clientId: "k", text: "@bea @ann look" }, { text: "@bea @ann look", attachments: [] });
    expect(pushed).toEqual([{
      kind: "mention", roomId: "r1", chatId: "c1", seq: 2, authorName: "ann", text: "@bea @ann look", everyone: false, userIds: ["u2"],
    }]);
  });

  it("an edit tells only the members it newly mentions", async () => {
    roomOfThree(stored({ text: "@cy hi", mentions: ["u3"] }));
    await chatRepo().edit(me, { ...at, seq: 1, text: "@cy @bea hi" });
    expect(pushed).toMatchObject([{ kind: "mention", seq: 1, text: "@cy @bea hi", userIds: ["u2"] }]);
  });

  it("a copy of a message sent elsewhere tells no one again", async () => {
    roomOfThree(stored());
    await chatRepo().send(me, { ...at, clientId: "k", text: "@bea" }, { text: "@bea", attachments: [] }, { copy: true });
    expect(pushed).toEqual([]);
  });
});

describe("send", () => {
  const keysWritten = (send: ReturnType<typeof fakeTable>) =>
    writes(send).filter((c) => c instanceof UpdateCommand).map((c) => String((c as UpdateCommand).input.Key?.sk));
  const post = (opts?: { system?: boolean }) =>
    chatRepo().send(me, { ...at, clientId: "k1", text: "Morning digest" }, { text: "Morning digest", attachments: [] }, opts);

  it("marks a member's own message read for them", async () => {
    const send = fakeTable({}, () => ({ Attributes: { lastSeq: 5 } }));
    expect(await post()).toMatchObject({ seq: 5 });
    expect(keysWritten(send)).toContain("READ#u1#c1");
  });

  it("moves no read marker for a message the server posts in its own name", async () => {
    const send = fakeTable({}, () => ({ Attributes: { lastSeq: 5 } }));
    expect(await post({ system: true })).toMatchObject({ seq: 5, authorName: "ann" });
    expect(keysWritten(send).some((k) => k.startsWith("READ#"))).toBe(false);
  });

  it("stores an agent post's thread link, moves no read marker, and notifies the people it names", async () => {
    const send = fakeTable({}, (c) => (c instanceof QueryCommand ? { Items: [me, { userId: "u2", username: "bea" }] } : { Attributes: { lastSeq: 5 } }));
    const agentPost = { threadId: "t1", number: 7 };
    const text = "Deploy done, @bea";
    const message = await chatRepo().send(
      { userId: "agent", username: "scout" }, { ...at, clientId: "k1", text }, { text, attachments: [] }, { system: true, agentPost },
    );
    expect(message).toMatchObject({ authorName: "scout", agentPost });
    const put = writes(send).find((c) => c instanceof PutCommand) as PutCommand;
    expect(put.input.Item).toMatchObject({ authorId: "agent", agentPost });
    expect(keysWritten(send)).not.toContain("READ#agent#c1");
    expect(pushed).toMatchObject([{ kind: "mention", authorName: "scout", userIds: ["u2"] }]);
  });
});

describe("edit and reaction rate", () => {
  /** The rate counter answers `n`; everything else as a stored message. */
  const counting = (n: number) => fakeTable(stored(), (c) => (isRate(c) ? { Attributes: { n } } : { Attributes: stored({ v: 1 }) }));
  const rateKeys = (send: ReturnType<typeof fakeTable>) =>
    send.mock.calls.map(([c]) => c).filter(isRate).map((c) => (c as UpdateCommand).input.Key);

  it("edits and reactions count on one key per member and room, apart from sends", async () => {
    const send = counting(1);
    await chatRepo().edit(me, { ...at, seq: 1, text: "hello" });
    await chatRepo().react(me, { ...at, seq: 1, reaction: "thumbs", on: true });
    const keys = rateKeys(send);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[0]!.pk).toBe("RATE#changes#r1#u1");
  });

  it("the 61st in a minute is refused in the words a send's limit uses", async () => {
    counting(61);
    await expect(chatRepo().react(me, { ...at, seq: 1, reaction: "thumbs", on: true }))
      .rejects.toThrow("Slow down: 60 edits and reactions a minute.");
    await expect(chatRepo().edit(me, { ...at, seq: 1, text: "hello" })).rejects.toThrow("Slow down: 60 edits and reactions a minute.");
  });

  it("a refused change writes nothing", async () => {
    const send = counting(61);
    await chatRepo().react(me, { ...at, seq: 1, reaction: "thumbs", on: true }).catch(() => {});
    expect(writes(send)).toEqual([]);
  });
});

describe("an archived chat", () => {
  const conditionFailed = () => Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" });
  /** Chat c1 is archived: its counter says so, and its counter's conditional increment fails. */
  const archivedChat = () => vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const sk = String(c.input.Key?.sk);
      return { Item: sk.startsWith("MEMBER#") ? { role: "owner" } : sk === "META" ? { roomId: "r1", lastSeq: 1, archived: true } : stored() };
    }
    if (c instanceof UpdateCommand && String(c.input.Key?.sk) === "META") throw conditionFailed();
    return {};
  }) as never);
  const closed = new Gone("This chat is archived.");

  it("takes no sends, edits, reactions or typing, and a refused send counts towards no limit", async () => {
    const send = archivedChat();
    await expect(chatRepo().admit(me, { ...at, text: "hi" })).rejects.toEqual(closed);
    await expect(chatRepo().edit(me, { ...at, seq: 1, text: "hello" })).rejects.toEqual(closed);
    await expect(chatRepo().react(me, { ...at, seq: 1, reaction: "thumbs", on: true })).rejects.toEqual(closed);
    await expect(chatRepo().assertCanType(me.userId, at)).rejects.toEqual(closed);
    expect(send.mock.calls.map(([c]) => c).filter(isRate)).toEqual([]);
  });

  it("refuses a message the server posts itself too: the increment that numbers it checks the flag", async () => {
    const send = archivedChat();
    await expect(chatRepo().send(me, { ...at, clientId: "k", text: "Morning digest" }, { text: "Morning digest", attachments: [] }, { system: true }))
      .rejects.toEqual(closed);
    const increment = send.mock.calls.map(([c]) => c).find((c) => c instanceof UpdateCommand) as UpdateCommand;
    expect(increment.input.ConditionExpression).toBe("roomId = :r AND attribute_not_exists(archived)");
  });

  it("still lets a message be deleted: removal is how a room takes something back", async () => {
    archivedChat();
    expect((await chatRepo().remove(me, { ...at, seq: 1 })).message.seq).toBe(1);
  });
});
