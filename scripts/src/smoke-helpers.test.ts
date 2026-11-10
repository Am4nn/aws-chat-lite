import { describe, it, expect } from "vitest";
import { clsFrom } from "./smoke-helpers.js";

describe("clsFrom (cumulative layout shift)", () => {
  it("adds up shifts, ignoring the ones right after user input", () => {
    expect(clsFrom([{ value: 0.05, hadRecentInput: false }, { value: 0.3, hadRecentInput: true }])).toBeCloseTo(0.05);
    expect(clsFrom([])).toBe(0);
  });
});

