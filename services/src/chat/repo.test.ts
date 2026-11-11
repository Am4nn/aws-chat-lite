import { describe, it, expect, vi, afterEach } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { chatRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

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

const writes = (send: ReturnType<typeof fakeTable>) => send.mock.calls.map(([c]) => c).filter((c) => !(c instanceof GetCommand));

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

  it("a delete returns the stored message, so a reaction racing it can't leave two broadcasts with one version", async () => {
    const send = fakeTable(stored({ v: 1 }), () => ({ Attributes: stored({ v: 3, deleted: "self", reactions: { heart: new Set(["u2"]) } }) }));
    expect(await chatRepo().remove(me, { ...at, seq: 1 })).toMatchObject({ deleted: "self", v: 3 });
    expect((writes(send)[0] as UpdateCommand).input.ReturnValues).toBe("ALL_NEW");
  });

  it("a delete and a reaction each bump the version", async () => {
    const send = fakeTable(stored({ v: 1 }), (c) => ({ Attributes: { ...stored({ v: 2 }), reactions: { thumbs: new Set(["u1"]) } }, c }));
    await chatRepo().remove(me, { ...at, seq: 1 });
    await chatRepo().react(me, { ...at, seq: 1, reaction: "thumbs", on: true });
    const [del, react] = writes(send) as UpdateCommand[];
    expect(del.input.UpdateExpression).toContain("ADD v :one");
    expect(react.input.UpdateExpression).toContain("v :one");
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
    fakeTable(stored(), () => { throw conflict(); });
    await expect(chatRepo().edit(me, { ...at, seq: 1, text: "hello" })).rejects.toThrow("That message just changed; try again.");
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
});
