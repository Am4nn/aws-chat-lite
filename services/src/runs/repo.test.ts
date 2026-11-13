import { describe, it, expect, vi, afterEach } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { runsRepo } from "./repo.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const run = { roomId: "r1", number: 3 };
const said = (seq: number, text: string, extra: object = {}) => ({
  pk: "CHAT#general-id", sk: `MSG#${String(seq).padStart(10, "0")}`, roomId: "r1", chatId: "general-id", seq, authorId: "u1",
  authorName: "ann", text, textLower: text, createdAt: "2026-11-11T00:00:00.000Z", attachments: [], mentions: [], everyone: false, ...extra,
});

/** A thread started from message 30 of #general; `messages` answers the chat query, `extra` any single message read. */
function fakeTable(o: { from?: object; messages: object[]; extra?: object }) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) return { Item: String(c.input.Key?.sk).startsWith("THREAD#") ? o.from && { from: o.from } : o.extra };
    if (c instanceof QueryCommand && c.input.ExpressionAttributeValues?.[":c"] === "CHAT#") return { Items: [{ name: "general" }] };
    return { Items: o.messages };
  }) as never);
}
const commands = (send: ReturnType<typeof fakeTable>) => send.mock.calls.map(([c]) => c);

describe("background", () => {
  const from = { chatId: "general-id", seq: 30 };

  it("is nothing for a thread that wasn't started from a people chat", async () => {
    fakeTable({ messages: [] });
    expect(await runsRepo().background(run)).toBeNull();
  });

  it("reads the chat's 20 messages before the one that started the thread, under the chat's name", async () => {
    const send = fakeTable({ from, messages: [said(28, "a"), said(29, "b"), said(30, "@agent look")] });
    const background = await runsRepo().background(run);
    expect(background).toMatchObject({ chat: "general", before: [{ seq: 28, text: "a" }, { seq: 29, text: "b" }] });
    expect(background!.replyTo).toBeUndefined();
    const [thread, ...queries] = commands(send) as [GetCommand, ...QueryCommand[]];
    // `from` and `name` are DynamoDB reserved words, so both go through placeholders.
    expect(thread.input).toMatchObject({ ProjectionExpression: "#from", ExpressionAttributeNames: { "#from": "from" } });
    const chat = queries.find((q) => q.input.ExpressionAttributeValues?.[":p"] === "CHAT#general-id")!;
    expect(chat.input.ExpressionAttributeValues).toMatchObject({ ":from": "MSG#0000000010", ":to": "MSG#0000000030" });
  });

  it("finds the message replied to in what it read, or reads it when it is further back", async () => {
    fakeTable({ from, messages: [said(29, "b"), said(30, "@agent look", { replyTo: { seq: 29, authorName: "ann", excerpt: "b" } })] });
    expect(await runsRepo().background(run)).toMatchObject({ replyTo: { seq: 29, text: "b" } });

    const send = fakeTable({ from, messages: [said(30, "@agent look", { replyTo: { seq: 2, authorName: "ann", excerpt: "old" } })], extra: said(2, "old") });
    expect(await runsRepo().background(run)).toMatchObject({ replyTo: { seq: 2, text: "old" }, before: [] });
    expect((commands(send).at(-1) as GetCommand).input.Key).toEqual({ pk: "CHAT#general-id", sk: "MSG#0000000002" });
  });

  it("hands over a deleted message blanked, as every reader gets it", async () => {
    fakeTable({ from, messages: [said(29, "secret", { deleted: "self" }), said(30, "@agent look")] });
    expect((await runsRepo().background(run))!.before).toMatchObject([{ seq: 29, text: "", deleted: "self" }]);
  });
});
