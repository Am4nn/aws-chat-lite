import { describe, expect, it } from "vitest";
import { answerParagraphs, budgetFill, clockTime, dayKey, dayLabel, excerpt, fileSize, formatElapsed, formatStepCost, formatStepTime, formatTokens, formatUsd, formatWait, matchSnippet, resetsOn, shortWhen, splitHeadline, streamWords, timeAgo, typingText } from "./format";

describe("format", () => {
  it("formatElapsed", () => {
    expect(formatElapsed(64_000)).toBe("1:04");
    expect(formatElapsed(3_726_000)).toBe("1:02:06");
    expect(formatElapsed(-5000)).toBe("0:00");
  });
  it("formatUsd", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1_500)).toBe("<$0.01");
    expect(formatUsd(42_000)).toBe("$0.04");
    expect(formatUsd(15_000)).toBe("$0.02");
    expect(formatUsd(1_005_000)).toBe("$1.01");
    expect(formatUsd(2_675_000)).toBe("$2.68");
  });
  it("budgetFill", () => {
    expect(budgetFill({ spentMicros: 1.5e6, capMicros: 3e6 })).toBe(50);
    expect(budgetFill({ spentMicros: 4e6, capMicros: 3e6 })).toBe(100);
    expect(budgetFill({ spentMicros: 0, capMicros: 0 })).toBe(100);
  });
  it("splitHeadline", () => {
    expect(splitHeadline("Title\n\nbody")).toEqual({ headline: "Title", body: "body" });
    expect(splitHeadline("one line only")).toEqual({ headline: null, body: "one line only" });
    expect(splitHeadline(`${"x".repeat(121)}\n\nbody`).headline).toBeNull();
  });
  it("streamWords", () => {
    expect(streamWords("hello wor", false)).toEqual(["hello"]);
    expect(streamWords("hello wor", true)).toEqual(["hello", "wor"]);
    expect(streamWords("hello wor ", false)).toEqual(["hello", "wor"]);
  });
});


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
  it("never splits an emoji in two", () => expect(excerpt(`${"x".repeat(139)}😀y`)).toBe(`${"x".repeat(139)}😀…`));
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
  it("shortWhen: the time today, the date before, the year only when it differs", () => {
    expect(shortWhen("2026-11-11T04:30:00Z", now, tz)).toBe("10:00 AM");
    expect(shortWhen("2026-11-02T01:00:00Z", now, tz)).toBe("Nov 2");
    expect(shortWhen("2025-11-02T01:00:00Z", now, tz)).toBe("Nov 2, 2025");
  });
});

describe("matchSnippet", () => {
  it("splits out the first match, ignoring case", () =>
    expect(matchSnippet("Deploy the API\ntoday", "the api")).toEqual({ before: "Deploy ", match: "the API", after: " today" }));
  it("trims long context on both sides", () => {
    const s = matchSnippet(`${"a".repeat(80)} needle ${"b".repeat(200)}`, "needle");
    expect(s.before).toBe(`…${"a".repeat(39)} `);
    expect(s.match).toBe("needle");
    expect(s.after).toBe(` ${"b".repeat(119)}…`);
  });
  it("falls back to the plain excerpt when the text doesn't contain it", () =>
    expect(matchSnippet("hello", "zz")).toEqual({ before: "hello", match: "", after: "" }));
});

describe("a step's tokens and cost", () => {
  it.each([[0, "0"], [940, "940"], [1100, "1.1k"], [6_800, "6.8k"], [12_000, "12k"]])("%i tokens → %s", (n, text) => expect(formatTokens(n)).toBe(text));
  it("shows tenths of a cent", () => expect([formatStepCost(3000), formatStepCost(11_400)]).toEqual(["$0.003", "$0.011"]));
});

describe("formatStepTime", () => {
  it.each([
    [412, "0.4s"],
    [1100, "1.1s"],
    [9_960, "10s"],
    [38_200, "38s"],
    [64_000, "1:04"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatStepTime(ms)).toBe(text);
  });
});

describe("answerParagraphs", () => {
  it("splits paragraphs and holds back the trailing partial word while streaming", () => {
    expect(answerParagraphs("one two\n\nthree fo", false)).toEqual([["one", "two"], ["three"]]);
    expect(answerParagraphs("one two\n\nthree fo", true)).toEqual([["one", "two"], ["three", "fo"]]);
  });

  it("treats words before a paragraph break as complete and drops empty paragraphs", () => {
    expect(answerParagraphs("one two\n\n", false)).toEqual([["one", "two"]]);
    expect(answerParagraphs("a\n\n\n\nb", true)).toEqual([["a"], ["b"]]);
    expect(answerParagraphs("", false)).toEqual([]);
  });
});

describe("resetsOn", () => {
  it("names the UTC day the budget resets, whatever the reader's zone", () => {
    expect(resetsOn("2026-12-01T00:00:00.000Z")).toBe("Dec 1");
  });
});

describe("formatWait", () => {
  it("hours, minutes, or under a minute", () => {
    expect(formatWait(7200)).toBe("2 h");
    expect(formatWait(5400)).toBe("1 h 30 min");
    expect(formatWait(2700)).toBe("45 min");
    expect(formatWait(30)).toBe("under a minute");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("counts minutes, hours, then days", () => {
    expect(timeAgo(ago(5 * 60_000), now)).toBe("5m ago");
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe("3h ago");
    expect(timeAgo(ago(2 * 86_400_000), now)).toBe("2d ago");
  });
  it("says just now under a minute", () => expect(timeAgo(ago(20_000), now)).toBe("just now"));
});
