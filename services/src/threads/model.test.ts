import { describe, expect, it } from "vitest";
import { ARCHIVE_AFTER_SEC, PROVISIONAL, isArchived, leadingTag, summaryLine, threadName, threadSk, uniqueCandidates } from "./model.js";

describe("threadName", () => {
  it("trims and lowercases", () => expect(threadName(" PR-Check ")).toBe("pr-check"));
  it.each(["12", "a".repeat(33), "", 5])("rejects %j", (raw) => expect(() => threadName(raw)).toThrow(/at least one letter/));
});

it("builds provisional names and sort keys", () => {
  expect(PROVISIONAL(7)).toBe("thread-7");
  expect(threadSk(7)).toBe("THREAD#0000000007");
});

describe("uniqueCandidates", () => {
  it("suffixes -2 to -9", () => {
    const list = uniqueCandidates("x");
    expect(list).toHaveLength(9);
    expect(list[0]).toBe("x");
    expect(list[8]).toBe("x-9");
  });
  it("trims a long base so every candidate fits", () => {
    for (const c of uniqueCandidates("a".repeat(32))) expect(c.length).toBeLessThanOrEqual(32);
  });
});

describe("isArchived", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  const idle = (sec: number) => new Date(now - sec * 1000).toISOString();
  it("archives after seven idle days", () => {
    expect(isArchived({ status: "done", lastActivityAt: idle(ARCHIVE_AFTER_SEC + 1) }, now)).toBe(true);
    expect(isArchived({ status: "done", lastActivityAt: idle(ARCHIVE_AFTER_SEC - 1) }, now)).toBe(false);
  });
  it("never archives a running thread", () => {
    expect(isArchived({ status: "running", lastActivityAt: idle(30 * 86400) }, now)).toBe(false);
  });
});

describe("leadingTag", () => {
  it("reads a number", () => expect(leadingTag("#12 also")).toEqual({ number: 12 }));
  it("reads a name and ignores later tags", () => expect(leadingTag("#pr-check also look at #43")).toEqual({ name: "pr-check" }));
  it("ignores a tag that is not first", () => expect(leadingTag("look at #43")).toBeNull());
  it("treats digits followed by letters as a name", () => expect(leadingTag("#12abc")).toEqual({ name: "12abc" }));
  it("accepts a tag at the very end", () => expect(leadingTag("#12")).toEqual({ number: 12 }));
});

describe("summaryLine", () => {
  it("takes the first non-empty line", () => expect(summaryLine("\n\nShip it.\nmore")).toBe("Ship it."));
  it("cuts at 80 characters", () => expect(summaryLine("a".repeat(100))).toBe("a".repeat(80) + "…"));
});
