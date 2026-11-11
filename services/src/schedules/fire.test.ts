import { describe, expect, it, vi } from "vitest";
import type { Schedule } from "../threads/types.js";
import { fireSchedule, type FireDeps } from "./fire.js";

const schedule: Schedule = {
  scheduleId: "s1", agentId: "a-scout", title: "Morning digest", prompt: "Digest the news.", cadence: { kind: "daily", time: "09:00" },
  chatId: "c1", enabled: true, createdBy: "u1", createdByName: "aman", createdAt: "2026-11-01T00:00:00.000Z",
};
const input = { roomId: "r1", scheduleId: "s1", at: "2026-11-10T03:30:00Z" };
const occurrence = "2026-11-10T03:30:00.000Z";

/** A live room in Asia/Kolkata with budget left, scout and schedule s1 switched on; `over` changes one part. */
function fakeDeps(over: { schedule?: Schedule | null; archived?: boolean; agent?: { deleted?: boolean } | null; claimed?: boolean; spent?: number } = {}) {
  const deps = {
    schedules: {
      get: vi.fn(async () => (over.schedule === undefined ? schedule : over.schedule)),
      setEnabled: vi.fn(async () => {}),
      claimFire: vi.fn(async () => over.claimed ?? true),
      recordRun: vi.fn(async () => {}),
    },
    trigger: { remove: vi.fn(async () => {}) },
    agent: vi.fn(async () => (over.agent === undefined ? { agentId: "a-scout" } : over.agent)),
    room: vi.fn(async () => ({ archived: over.archived ?? false, timeZone: "Asia/Kolkata" })),
    budget: vi.fn(async () => ({ spentMicros: over.spent ?? 0, capMicros: 3_000_000 })),
    open: vi.fn(async () => 7),
  };
  return deps as typeof deps & FireDeps;
}

describe("fireSchedule", () => {
  it("claims the occurrence, opens its thread and records the run: started", async () => {
    const deps = fakeDeps();
    expect(await fireSchedule(input, deps)).toBe("started");
    expect(deps.schedules.claimFire).toHaveBeenCalledWith("r1", "s1", occurrence);
    expect(deps.open).toHaveBeenCalledWith("r1", schedule, occurrence, "Asia/Kolkata");
    expect(deps.schedules.recordRun).toHaveBeenCalledWith("r1", "s1", { at: occurrence, threadNumber: 7 });
    expect(deps.trigger.remove).not.toHaveBeenCalled();
  });

  it.each([
    ["the schedule is gone", { schedule: null }, false],
    ["the schedule is off", { schedule: { ...schedule, enabled: false } }, false],
    ["the room is archived", { archived: true }, true],
    ["the agent is deleted", { agent: { deleted: true } }, true],
    ["the agent is gone", { agent: null }, true],
  ])("retires its trigger when %s, and switches the schedule off if it was on", async (_case, over, switchedOff) => {
    const deps = fakeDeps(over);
    expect(await fireSchedule(input, deps)).toBe("retired");
    expect(deps.trigger.remove).toHaveBeenCalledOnce();
    expect(deps.trigger.remove).toHaveBeenCalledWith("s1");
    if (switchedOff) expect(deps.schedules.setEnabled).toHaveBeenCalledWith("r1", "s1", false);
    else expect(deps.schedules.setEnabled).not.toHaveBeenCalled();
    expect(deps.schedules.claimFire).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("does nothing after a claim another fire already holds: duplicate", async () => {
    const deps = fakeDeps({ claimed: false });
    expect(await fireSchedule(input, deps)).toBe("duplicate");
    expect(deps.schedules.recordRun).not.toHaveBeenCalled();
    expect(deps.schedules.setEnabled).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("notes the skip on the schedule when the room's budget is spent: skipped", async () => {
    const deps = fakeDeps({ spent: 3_000_000 });
    expect(await fireSchedule(input, deps)).toBe("skipped");
    expect(deps.schedules.recordRun).toHaveBeenCalledWith("r1", "s1", { at: occurrence, skipped: "Skipped: the room's budget is spent." });
    expect(deps.open).not.toHaveBeenCalled();
  });
});
