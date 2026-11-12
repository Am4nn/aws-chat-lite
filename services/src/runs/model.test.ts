import { describe, expect, it } from "vitest";
import { budgetText } from "../budget/model.js";
import { DEAD_AFTER_MS, endReason, stoppedBy } from "./model.js";

const base = { steps: 0, startedAtMs: 1_000, spentMicros: 0, capMicros: 3_000_000, month: "2026-11" };
const now = 1_000 + 60_000;

describe("endReason", () => {
  it("stops when a member asked", () => {
    expect(endReason({ ...base, stopRequestedBy: "aman" }, now)).toEqual({ status: "stopped", reason: "Stopped by aman." });
    expect(stoppedBy("aman")).toEqual({ status: "stopped", reason: "Stopped by aman." });
  });
  it("stops once the room is archived, after a member's own stop", () => {
    expect(endReason({ ...base, archived: true }, now)).toEqual({ status: "stopped", reason: "The room was archived." });
    expect(endReason({ ...base, archived: true, stopRequestedBy: "aman" }, now)?.reason).toBe("Stopped by aman.");
  });
  it("caps at the budget", () => {
    expect(endReason({ ...base, spentMicros: 3_000_000 }, now)).toEqual({ status: "capped", reason: budgetText(3_000_000, "2026-11") });
  });
  it("ends at the step limit", () => {
    expect(endReason({ ...base, steps: 200 }, now)?.reason).toBe("Step limit reached (200 steps).");
  });
  it("ends at the time limit", () => {
    expect(endReason(base, 1_000 + 7_200_001)?.reason).toBe("Time limit reached (2 hours).");
  });
  it("leaves time spent waiting for an approval off the time limit", () => {
    const later = 1_000 + 9_000_000;
    expect(endReason({ ...base, pausedMs: 3_600_000 }, later)).toBeNull();
    expect(endReason({ ...base, pausedMs: 0 }, later)?.reason).toBe("Time limit reached (2 hours).");
  });
  it("counts a run as dead 135 minutes after its claim or its approval's expiry", () => {
    expect(DEAD_AFTER_MS).toBe(135 * 60_000);
  });
  it("continues otherwise", () => expect(endReason(base, now)).toBeNull());
  it("prefers stop over budget over steps over time", () => {
    const all = { ...base, steps: 200, spentMicros: 3_000_000 };
    expect(endReason({ ...all, stopRequestedBy: "a" }, 1_000 + 7_200_001)?.status).toBe("stopped");
    expect(endReason(all, 1_000 + 7_200_001)?.status).toBe("capped");
    expect(endReason({ ...base, steps: 200 }, 1_000 + 7_200_001)?.reason).toMatch(/^Step/);
  });
});
