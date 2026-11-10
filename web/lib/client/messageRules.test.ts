import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { canDelete, canEdit, canEditLast, startsGroup } from "./messageRules";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const msg = (seq: number, extra: Partial<Message> = {}): Message => ({
  roomId: "r", chatId: "c", seq, authorId: "me", authorName: "me", text: `m${seq}`, createdAt: ago(1),
  attachments: [], reactions: {}, mentions: [], everyone: false, ...extra,
});

describe("canEdit and canDelete", () => {
  it("lets the author edit for 15 minutes", () => {
    expect(canEdit(msg(1, { createdAt: ago(14) }), "me", NOW)).toBe(true);
    expect(canEdit(msg(1, { createdAt: ago(16) }), "me", NOW)).toBe(false);
  });
  it("never edits someone else's or a deleted message", () => {
    expect(canEdit(msg(1, { authorId: "bob" }), "me", NOW)).toBe(false);
    expect(canEdit(msg(1, { deleted: "self" }), "me", NOW)).toBe(false);
  });
  it("lets an admin delete anyone's message any time, and a member only their own within the window", () => {
    const old = msg(1, { authorId: "bob", createdAt: ago(600) });
    expect(canDelete(old, "me", "admin", NOW)).toBe(true);
    expect(canDelete(old, "me", "member", NOW)).toBe(false);
    expect(canDelete(msg(2), "me", "member", NOW)).toBe(true);
    expect(canDelete(msg(3, { deleted: "self" }), "me", "owner", NOW)).toBe(false);
  });
});

describe("canEditLast", () => {
  it("picks my newest non-deleted message", () => {
    const list = [msg(1), msg(2), msg(3, { deleted: "self" }), msg(4, { authorId: "bob" })];
    expect(canEditLast(list, "me", NOW)?.seq).toBe(2);
  });
  it("gives nothing when my newest message is past the window, rather than an older one", () => {
    const list = [msg(1, { createdAt: ago(20) }), msg(2, { createdAt: ago(16) })];
    expect(canEditLast(list, "me", NOW)).toBeUndefined();
  });
  it("gives nothing when I haven't written anything", () => {
    expect(canEditLast([msg(1, { authorId: "bob" })], "me", NOW)).toBeUndefined();
  });
});

describe("startsGroup", () => {
  it("starts a group on a new author or after a five-minute pause", () => {
    expect(startsGroup(undefined, msg(1))).toBe(true);
    expect(startsGroup(msg(1, { createdAt: ago(3) }), msg(2, { createdAt: ago(1) }))).toBe(false);
    expect(startsGroup(msg(1, { createdAt: ago(9) }), msg(2, { createdAt: ago(1) }))).toBe(true);
    expect(startsGroup(msg(1, { authorId: "bob" }), msg(2))).toBe(true);
  });
});
