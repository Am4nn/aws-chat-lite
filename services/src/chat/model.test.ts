import { describe, it, expect } from "vitest";
import {
  canEdit, deleteMode, excerpt, forReaders, messageText, seqKey, seqNumber, validAttachment, versionKey, type StoredMessage,
} from "./model.js";
import { ValidationError } from "../lib/errors.js";

const T0 = Date.parse("2026-11-11T10:00:00Z");
const min = 60_000;
const msg = { authorId: "u1", createdAt: new Date(T0).toISOString() };

describe("canEdit", () => {
  it("is true for the author inside the window", () => expect(canEdit(msg, "u1", T0 + 899_000)).toBe(true));
  it("is false after the window", () => expect(canEdit(msg, "u1", T0 + 901_000)).toBe(false));
  it("is false for someone else", () => expect(canEdit(msg, "u2", T0 + 1000)).toBe(false));
  it("is false once deleted", () => expect(canEdit({ ...msg, deleted: "self" }, "u1", T0 + 1000)).toBe(false));
});

describe("deleteMode", () => {
  it("lets the author delete within 15 minutes", () => expect(deleteMode(msg, "u1", "member", T0 + 10 * min)).toBe("self"));
  it("refuses the author after 15 minutes", () => expect(deleteMode(msg, "u1", "member", T0 + 20 * min)).toBeNull());
  it("lets an admin remove another's message any time", () =>
    expect(deleteMode(msg, "u2", "admin", T0 + 24 * 60 * min)).toBe("admin"));
  it("refuses a member on another's message", () => expect(deleteMode(msg, "u2", "member", T0 + min)).toBeNull());
  it("treats an owner's own old message as an admin removal", () =>
    expect(deleteMode(msg, "u1", "owner", T0 + 20 * min)).toBe("admin"));
  it("treats an owner's own recent message as self", () =>
    expect(deleteMode(msg, "u1", "owner", T0 + min)).toBe("self"));
});

describe("excerpt", () => {
  it("cuts at 140 characters and adds an ellipsis", () => expect(excerpt("a".repeat(200)).length).toBe(141));
  it("collapses whitespace", () => expect(excerpt("a \n\n  b")).toBe("a b"));
});

describe("messageText", () => {
  it("trims", () => expect(messageText("  hi ")).toBe("hi"));
  it("rejects over 4000 characters and non-strings", () => {
    expect(() => messageText("x".repeat(4001))).toThrow(ValidationError);
    expect(() => messageText(5)).toThrow(ValidationError);
  });
});

describe("seqKey", () => {
  it("zero-pads to 10 digits", () => expect(seqKey(42)).toBe("MSG#0000000042"));
  it("keeps versions apart from messages, ordered by edit time", () =>
    expect(versionKey(42, "2026-11-11T10:00:00.000Z")).toBe("VER#0000000042#2026-11-11T10:00:00.000Z"));
});

describe("seqNumber", () => {
  it("accepts whole numbers that fit the key", () => expect(seqNumber(7)).toBe(7));
  it("rejects anything else", () => {
    for (const bad of [-1, 1.5, NaN, 1e10, "3", undefined]) expect(() => seqNumber(bad)).toThrow(ValidationError);
  });
});

describe("validAttachment", () => {
  const ok = { key: "rooms/r1/u1/a.png", name: "a.png", size: 10, type: "image/png" };
  it("returns the four fields", () => expect(validAttachment({ ...ok, extra: 1 }, "r1", "u1")).toEqual(ok));
  it("rejects a key in another room or under another user", () => {
    expect(() => validAttachment({ ...ok, key: "rooms/other/u1/x" }, "r1", "u1")).toThrow(ValidationError);
    expect(() => validAttachment({ ...ok, key: "rooms/r1/u2/x" }, "r1", "u1")).toThrow(ValidationError);
  });
  it("rejects bad sizes", () => {
    for (const size of [10_485_761, 0, 1.5]) expect(() => validAttachment({ ...ok, size }, "r1", "u1")).toThrow(ValidationError);
  });
  it("rejects bad names and types", () => {
    expect(() => validAttachment({ ...ok, name: "n".repeat(201) }, "r1", "u1")).toThrow(ValidationError);
    expect(() => validAttachment({ ...ok, type: "" }, "r1", "u1")).toThrow(ValidationError);
    expect(() => validAttachment({ ...ok, type: "t".repeat(101) }, "r1", "u1")).toThrow(ValidationError);
    expect(() => validAttachment(null, "r1", "u1")).toThrow(ValidationError);
  });
});

describe("forReaders", () => {
  const stored: StoredMessage = {
    roomId: "r", chatId: "c", seq: 1, authorId: "u1", authorName: "a", text: "secret", textLower: "secret",
    createdAt: "2026-11-11T10:00:00Z", attachments: [], reactions: {}, mentions: [], everyone: false,
  };
  it("blanks a deleted message, its files too, and drops textLower", () => {
    const file = { key: "rooms/r/u1/id/a.png", name: "a.png", size: 1, type: "image/png" };
    const out = forReaders({ ...stored, attachments: [file], deleted: "admin" });
    expect(out.text).toBe("");
    expect(out.attachments).toEqual([]);
    expect(out).not.toHaveProperty("textLower");
  });
  it("keeps the text otherwise", () => expect(forReaders(stored).text).toBe("secret"));
});
