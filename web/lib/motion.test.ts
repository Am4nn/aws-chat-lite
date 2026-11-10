import { describe, it, expect } from "vitest";
import { dur } from "./motion";

describe("motion durations", () => {
  it("stay between 150 and 500 ms (fast enough to never block, slow enough to be seen)", () => {
    for (const [name, seconds] of Object.entries(dur)) {
      expect(seconds, name).toBeGreaterThanOrEqual(0.15);
      expect(seconds, name).toBeLessThanOrEqual(0.5);
    }
  });
});
