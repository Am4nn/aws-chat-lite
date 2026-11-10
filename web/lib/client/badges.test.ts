import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { chatBadge, countMessage, countRead, lastSeenText } from "./badges";

describe("chatBadge", () => {
  it("shows the unread count", () => expect(chatBadge({ unread: 3, mentions: 0, muted: false })).toEqual({ count: 3, mention: null }));
  it("hides the unread count when muted, but never the mentions", () =>
    expect(chatBadge({ unread: 3, mentions: 1, muted: true })).toEqual({ count: null, mention: 1 }));
  it("shows nothing when there's nothing new", () =>
    expect(chatBadge({ unread: 0, mentions: 0, muted: false })).toEqual({ count: null, mention: null }));
});

describe("lastSeenText", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("counts minutes, hours, then days", () => {
    expect(lastSeenText(ago(5 * 60_000), now)).toBe("last seen 5m ago");
    expect(lastSeenText(ago(3 * 3_600_000), now)).toBe("last seen 3h ago");
    expect(lastSeenText(ago(2 * 86_400_000), now)).toBe("last seen 2d ago");
  });
  it("says just now under a minute", () => expect(lastSeenText(ago(20_000), now)).toBe("last seen just now"));
});

describe("countMessage", () => {
  const chat = { lastSeq: 4, unread: 1, mentions: 0, muted: false };
  const msg = (over: Partial<Message>) => ({ seq: 5, authorId: "u-bob", mentions: [], everyone: false, ...over });

  it("counts someone else's message once, even if it's delivered twice", () => {
    const once = countMessage(chat, msg({}), "u-me");
    expect(once).toEqual({ ...chat, lastSeq: 5, unread: 2 });
    expect(countMessage(once, msg({}), "u-me")).toBe(once);
  });
  it("counts a mention of me or @everyone", () => {
    expect(countMessage(chat, msg({ mentions: ["u-me"] }), "u-me").mentions).toBe(1);
    expect(countMessage(chat, msg({ everyone: true }), "u-me").mentions).toBe(1);
  });
  it("doesn't count my own message, which is read by sending it", () =>
    expect(countMessage(chat, msg({ authorId: "u-me", everyone: true }), "u-me")).toEqual({ ...chat, lastSeq: 5 }));
});

describe("countRead", () => {
  it("leaves what's after the read marker unread and clears the mentions", () =>
    expect(countRead({ lastSeq: 9, unread: 5, mentions: 2, muted: true }, 7)).toEqual({ lastSeq: 9, unread: 2, mentions: 0, muted: true }));
});
