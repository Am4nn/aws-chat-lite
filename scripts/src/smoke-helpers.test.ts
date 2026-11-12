import { describe, it, expect } from "vitest";
import { clsFrom, gapless, streamedExactly } from "./smoke-helpers.js";

describe("clsFrom (cumulative layout shift)", () => {
  it("adds up shifts, ignoring the ones right after user input", () => {
    expect(clsFrom([{ value: 0.05, hadRecentInput: false }, { value: 0.3, hadRecentInput: true }])).toBeCloseTo(0.05);
    expect(clsFrom([])).toBe(0);
  });
});

describe("gapless", () => {
  it("accepts distinct numbers that leave no hole, in any order", () => {
    expect(gapless([7, 5, 6])).toBe(true);
    expect(gapless([5, 5, 6])).toBe(false);
    expect(gapless([5, 7])).toBe(false);
    expect(gapless([])).toBe(false);
  });
});

describe("streamedExactly", () => {
  const stored = "Fake answer.\n\nthe agent checked";
  it("passes when every sample leads up to the stored text and the last one is it", () => {
    expect(streamedExactly(["Fake", "Fake answer. the", "Fake answer.\nthe agent checked"], stored)).toBe(true);
  });
  it("fails on a repeated or dropped word, or when the stream never reached the end", () => {
    expect(streamedExactly(["Fake answer. the the", stored], stored)).toBe(false);
    expect(streamedExactly(["Fake answer. agent", stored], stored)).toBe(false);
    expect(streamedExactly(["Fake answer. the"], stored)).toBe(false);
    expect(streamedExactly([], stored)).toBe(false);
  });
});
