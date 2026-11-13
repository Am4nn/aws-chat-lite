import { describe, expect, it } from "vitest";
import { ARCHIVE_AFTER_SEC, provisionalName, claimableName, isArchived, isNumberedName, summary, slugName, summaryLine, threadName, threadSk, uniqueCandidates } from "./model.js";

describe("threadName", () => {
  it("trims and lowercases", () => expect(threadName(" PR-Check ")).toBe("pr-check"));
  it.each(["-help", "help-", "-"])("refuses %j, which starts or ends with a dash", (raw) => expect(() => threadName(raw)).toThrow(/letter/));
});

describe("slugName", () => {
  it.each([
    ["-help-clarify-request", "help-clarify-request"],
    ["- Help: clarify the request!", "help-clarify-the-request"],
    ["`deploy notes`\n", "deploy-notes"],
    ["a".repeat(40), "a".repeat(32)],
    [`${"x".repeat(31)}-tail`, "x".repeat(31)],
  ])("turns a model's %j into %j", (raw, name) => expect(slugName(raw)).toBe(name));
  it.each(["12", "a".repeat(33), "", 5])("rejects %j", (raw) => expect(() => threadName(raw)).toThrow(/at least one letter/));
});

it("builds provisional names and sort keys", () => {
  expect(provisionalName(7)).toBe("thread-7");
  expect(threadSk(7)).toBe("THREAD#0000000007");
});

it("keeps thread-<N> names for the numbered threads", () => {
  expect(isNumberedName("thread-12")).toBe(true);
  expect(isNumberedName("thread-12-2")).toBe(false);
  expect(isNumberedName("thread-x")).toBe(false);
  expect(() => claimableName("thread-3")).toThrow(/numbered threads/);
  expect(claimableName("pr-check")).toBe("pr-check");
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
  it("leaves out a trimmed candidate that lost the only letter", () => {
    const name = `${"1".repeat(31)}a`;
    expect(uniqueCandidates(name)).toEqual([name]);
  });
});

describe("isArchived", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  const idle = (sec: number) => new Date(now - sec * 1000).toISOString();
  it("archives after seven idle days", () => {
    expect(isArchived({ status: "done", lastActivityAt: idle(ARCHIVE_AFTER_SEC + 1) }, now)).toBe(true);
    expect(isArchived({ status: "done", lastActivityAt: idle(ARCHIVE_AFTER_SEC - 1) }, now)).toBe(false);
  });
  it("never archives a running thread, or one waiting on an approval", () => {
    expect(isArchived({ status: "running", lastActivityAt: idle(30 * 86400) }, now)).toBe(false);
    expect(isArchived({ status: "waiting", lastActivityAt: idle(30 * 86400) }, now)).toBe(false);
  });
});

describe("summaryLine", () => {
  it("takes the first non-empty line", () => expect(summaryLine("\n\nShip it.\nmore")).toBe("Ship it."));
  it("cuts at 80 characters", () => expect(summaryLine("a".repeat(100))).toBe("a".repeat(80) + "…"));
  it("never splits a character made of two UTF-16 units", () => expect(summaryLine("😀".repeat(81))).toBe("😀".repeat(80) + "…"));
});

describe("summary", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  const stored = {
    pk: "ROOM#r", sk: "THREAD#0000000001", roomId: "r", threadId: "t", number: 1, name: "thread-1", named: false,
    activeRunId: "run", deadAt: "2026-11-11T02:10:00Z", from: { chatId: "c", seq: 3 }, status: "done", rev: 4, steps: 2, costMicros: 9, createdBy: "u",
    lastActivityAt: new Date(now - (ARCHIVE_AFTER_SEC + 1) * 1000).toISOString(),
  };
  it("keeps the bookkeeping on the server and works out archived", () => {
    const t = summary(stored, now);
    for (const k of ["pk", "sk", "named", "activeRunId", "from"]) expect(t).not.toHaveProperty(k);
    // Clients read deadAt to retire a dead run at the same moment the server does.
    expect(t).toMatchObject({ threadId: "t", number: 1, status: "done", rev: 4, archived: true, deadAt: "2026-11-11T02:10:00Z" });
  });

  it("gives the taint as a sorted list, read from the stored string set, and [] when there is none", () => {
    expect(summary(stored, now).taint).toEqual([]);
    expect(summary({ ...stored, taint: new Set(["attachment"]) }, now).taint).toEqual(["attachment"]);
  });

  it("shows a running run past its deadAt as failed, so its thread stops looking live and can archive", () => {
    const dead = { ...stored, status: "running", startedAt: "2026-11-10T00:00:00Z", deadAt: new Date(now - 1).toISOString(), currentStep: "fake.lookup" };
    const t = summary(dead, now);
    expect(t).toMatchObject({ status: "failed", summary: "The run stopped responding.", archived: true });
    expect(t).not.toHaveProperty("currentStep");
  });

  it("goes by deadAt, not the start, so a run that waited on an approval still reads live", () => {
    const later = new Date(now + 60_000).toISOString();
    expect(summary({ ...stored, status: "running", startedAt: "2026-11-10T00:00:00Z", deadAt: later }, now).status).toBe("running");
    expect(summary({ ...stored, status: "waiting", deadAt: later }, now).status).toBe("waiting");
  });

  it("shows a waiting run past its deadAt as failed too, without its approval: the expiry would have woken a live one", () => {
    const approval = { step: 1, title: "Comment?", expiresAt: "2026-11-10T00:00:00Z" };
    const t = summary({ ...stored, status: "waiting", approval, deadAt: new Date(now - 1).toISOString() }, now);
    expect(t).toMatchObject({ status: "failed", summary: "The run stopped responding." });
    expect(t).not.toHaveProperty("approval");
  });
});
