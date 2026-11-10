import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { addPending, applyMessages, failPending, newestSeq, type Timeline } from "./timeline";

const msg = (seq: number, extra: Partial<Message> = {}): Message => ({
  roomId: "r", chatId: "c", seq, authorId: "u", authorName: "a", text: `m${seq}`, createdAt: "t",
  attachments: [], reactions: {}, mentions: [], everyone: false, ...extra,
});
const empty: Timeline = { messages: [], pending: [] };

describe("timeline", () => {
  it("keeps one copy of a message delivered twice", () => {
    const t = applyMessages(applyMessages(empty, [msg(1)]), [msg(1)]);
    expect(t.messages).toHaveLength(1);
  });
  it("sorts out-of-order messages", () => {
    expect(applyMessages(empty, [msg(3), msg(1), msg(2)]).messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
  it("drops the pending entry whose clientId arrived", () => {
    const p = { clientId: "k", text: "hi", attachments: [] };
    const t = applyMessages(addPending(empty, p), [msg(1, { clientId: "k" })]);
    expect(t.pending).toEqual([]);
  });
  it("replaces the text of an updated message with the same seq", () => {
    const t = applyMessages(applyMessages(empty, [msg(1)]), [msg(1, { text: "edited" })]);
    expect(t.messages[0].text).toBe("edited");
  });
  it("marks a pending entry failed", () => {
    const t = failPending(addPending(empty, { clientId: "k", text: "x", attachments: [] }), "k");
    expect(t.pending[0].failed).toBe(true);
  });
  it("reports the newest seq, 0 when empty", () => {
    expect(newestSeq(empty)).toBe(0);
    expect(newestSeq(applyMessages(empty, [msg(2), msg(5)]))).toBe(5);
  });
});
