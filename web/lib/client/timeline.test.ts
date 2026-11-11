import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { addPending, applyMessages, dropPending, failPending, newestSeq, skipsAhead, updateMessage, type Timeline } from "./timeline";

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
    const p = { clientId: "k", text: "hi", createdAt: "t", attachments: [] };
    const t = applyMessages(addPending(empty, p), [msg(1, { clientId: "k" })]);
    expect(t.pending).toEqual([]);
  });
  it("replaces the text of an updated message with the same seq", () => {
    const t = applyMessages(applyMessages(empty, [msg(1)]), [msg(1, { text: "edited" })]);
    expect(t.messages[0].text).toBe("edited");
  });
  it("keeps the copy with the higher version, so a stale page can't overwrite a newer change", () => {
    const live = applyMessages(empty, [msg(1, { text: "edited", v: 2 })]);
    expect(applyMessages(live, [msg(1, { text: "old", v: 1 })]).messages[0].text).toBe("edited");
    expect(applyMessages(live, [msg(1, { text: "old" })]).messages[0].text).toBe("edited");
    expect(applyMessages(live, [msg(1, { text: "newer", v: 3 })]).messages[0].text).toBe("newer");
  });
  it("tells when a live message skips seqs the timeline never got", () => {
    const t = applyMessages(empty, [msg(1), msg(2)]);
    expect(skipsAhead(t, 3)).toBe(false);
    expect(skipsAhead(t, 2)).toBe(false);
    expect(skipsAhead(t, 5)).toBe(true);
    expect(skipsAhead(empty, 2)).toBe(true);
  });
  it("marks a pending entry failed", () => {
    const t = failPending(addPending(empty, { clientId: "k", text: "x", createdAt: "t", attachments: [] }), "k");
    expect(t.pending[0].failed).toBe(true);
  });
  it("drops a pending entry by clientId", () => {
    const t = addPending(addPending(empty, { clientId: "a", text: "x", createdAt: "t", attachments: [] }), { clientId: "b", text: "y", createdAt: "t", attachments: [] });
    expect(dropPending(t, "a").pending.map((p) => p.clientId)).toEqual(["b"]);
  });
  it("updates one message from its newest copy, and leaves the timeline alone when the seq isn't loaded", () => {
    const t = applyMessages(empty, [msg(1), msg(2)]);
    expect(updateMessage(t, 2, (m) => ({ ...m, text: "x" })).messages.map((m) => m.text)).toEqual(["m1", "x"]);
    expect(updateMessage(t, 9, (m) => ({ ...m, text: "x" }))).toBe(t);
  });
  it("reports the newest seq, 0 when empty", () => {
    expect(newestSeq(empty)).toBe(0);
    expect(newestSeq(applyMessages(empty, [msg(2), msg(5)]))).toBe(5);
  });
});
