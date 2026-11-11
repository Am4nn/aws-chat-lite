import { describe, expect, it } from "vitest";
import { sandboxCostMicros } from "./limits.js";

describe("sandboxCostMicros", () => {
  it("charges at least one second and rounds up", () => {
    expect(sandboxCostMicros(0)).toBe(61);
    expect(sandboxCostMicros(1000)).toBe(61);
    expect(sandboxCostMicros(1001)).toBe(122);
  });
});
