import { describe, expect, it } from "vitest";
import type { Cadence } from "../types";
import { cadenceLabel, cadenceOfKind, nextLabel } from "./schedules";

describe("cadenceLabel", () => {
  it.each<[Cadence, string]>([
    [{ kind: "hours", every: 1, minute: 15 }, "Every hour at :15"],
    [{ kind: "hours", every: 6, minute: 15 }, "Every 6 hours at :15"],
    [{ kind: "hours", every: 2, minute: 5 }, "Every 2 hours at :05"],
    [{ kind: "daily", time: "09:00" }, "Every day at 09:00"],
    [{ kind: "weekdays", time: "18:30" }, "Weekdays at 18:30"],
    [{ kind: "weekly", day: "tue", time: "07:05" }, "Every Tuesday at 07:05"],
  ])("%j → %s", (cadence, label) => {
    expect(cadenceLabel(cadence)).toBe(label);
  });
});

describe("nextLabel", () => {
  it("shows the next fire on the room's wall clock", () => {
    expect(nextLabel("2026-11-11T03:30:00.000Z", "Asia/Kolkata")).toBe("next Wed 09:00");
    expect(nextLabel("2026-03-08T13:00:00.000Z", "America/New_York")).toBe("next Sun 09:00");
  });
});

describe("cadenceOfKind", () => {
  it("keeps the time of day across day-based kinds", () => {
    expect(cadenceOfKind({ kind: "daily", time: "18:30" }, "weekly")).toEqual({ kind: "weekly", day: "mon", time: "18:30" });
    expect(cadenceOfKind({ kind: "weekly", day: "fri", time: "07:05" }, "weekdays")).toEqual({ kind: "weekdays", time: "07:05" });
  });
  it("keeps the minute going to hours, and back", () => {
    expect(cadenceOfKind({ kind: "daily", time: "18:30" }, "hours")).toEqual({ kind: "hours", every: 1, minute: 30 });
    expect(cadenceOfKind({ kind: "hours", every: 6, minute: 15 }, "daily")).toEqual({ kind: "daily", time: "09:15" });
  });
});
