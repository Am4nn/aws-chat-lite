import { describe, expect, it } from "vitest";
import { budgetFill, formatElapsed, formatUsd, splitHeadline, streamWords } from "./format";

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
