import { describe, expect, it } from "vitest";
import { clockTime, dayKey, dayLabel, excerpt, fileSize, typingText } from "./format";

describe("typingText", () => {
  it("names up to two people, then counts", () => {
    expect(typingText([])).toBe("");
    expect(typingText(["a"])).toBe("a is typing…");
    expect(typingText(["a", "b"])).toBe("a and b are typing…");
    expect(typingText(["a", "b", "c"])).toBe("3 people are typing…");
  });
});

describe("excerpt", () => {
  it("flattens whitespace and cuts at 140 characters", () => {
    expect(excerpt(" a\n\n b ")).toBe("a b");
    expect(excerpt("x".repeat(150))).toBe(`${"x".repeat(140)}…`);
  });
});

describe("fileSize", () => {
  it("uses the largest unit that keeps the number readable", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2 KB");
    expect(fileSize(1536)).toBe("1.5 KB");
    expect(fileSize(10_485_760)).toBe("10 MB");
    expect(fileSize(3_565_158)).toBe("3.4 MB");
  });
});

describe("times and days", () => {
  const tz = "Asia/Kolkata";
  const now = Date.parse("2026-11-11T12:00:00Z");
  it("shows the clock time in the reader's zone", () => {
    expect(clockTime("2026-11-11T04:30:00Z", tz)).toBe("10:00 AM");
  });
  it("keys days by the reader's calendar, not UTC", () => {
    expect(dayKey("2026-11-10T19:00:00Z", tz)).toBe("2026-11-11");
    expect(dayKey("2026-11-10T18:00:00Z", tz)).toBe("2026-11-10");
  });
  it("says Today and Yesterday, then the date", () => {
    expect(dayLabel("2026-11-11T01:00:00Z", now, tz)).toBe("Today");
    expect(dayLabel("2026-11-10T01:00:00Z", now, tz)).toBe("Yesterday");
    expect(dayLabel("2026-11-02T01:00:00Z", now, tz)).toBe("Monday, November 2");
    expect(dayLabel("2025-11-02T01:00:00Z", now, tz)).toBe("Sunday, November 2, 2025");
  });
});
