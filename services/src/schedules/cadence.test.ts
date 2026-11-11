import { describe, expect, it } from "vitest";
import type { Cadence } from "../threads/types.js";
import { cronOf, fireAt, nextFire, parseCadence, prevFire, threadNameFor } from "./cadence.js";

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";
const daily9: Cadence = { kind: "daily", time: "09:00" };
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);

describe("parseCadence", () => {
  it.each<[unknown, Cadence]>([
    [{ kind: "hours", every: 6, minute: 15 }, { kind: "hours", every: 6, minute: 15 }],
    [{ kind: "daily", time: "09:00", extra: 1 }, { kind: "daily", time: "09:00" }],
    [{ kind: "weekdays", time: "23:59" }, { kind: "weekdays", time: "23:59" }],
    [{ kind: "weekly", day: "tue", time: "00:00" }, { kind: "weekly", day: "tue", time: "00:00" }],
  ])("keeps %j", (raw, cadence) => expect(parseCadence(raw)).toEqual(cadence));

  it.each([
    { kind: "hours", every: 5, minute: 0 },
    { kind: "hours", every: 1, minute: 60 },
    { kind: "hours", every: 1, minute: 1.5 },
    { kind: "minutes", every: 1 },
    { kind: "weekly", day: "someday", time: "09:00" },
    "daily",
    null,
  ])("refuses the cadence %j", (raw) => {
    expect(() => parseCadence(raw)).toThrow("Pick every 1, 2, 3, 4, 6, 8 or 12 hours, daily, weekdays or weekly.");
  });

  it.each(["9:00", "24:00", "09:60", 900])("refuses the time %j", (time) => {
    expect(() => parseCadence({ kind: "daily", time })).toThrow("Times are HH:MM, 24-hour.");
  });
});

describe("cronOf", () => {
  it.each<[Cadence, string]>([
    [daily9, "cron(0 9 * * ? *)"],
    [{ kind: "weekdays", time: "18:30" }, "cron(30 18 ? * MON-FRI *)"],
    [{ kind: "weekly", day: "tue", time: "07:05" }, "cron(5 7 ? * TUE *)"],
    [{ kind: "hours", every: 6, minute: 15 }, "cron(15 0/6 * * ? *)"],
  ])("%j is %s", (cadence, cron) => expect(cronOf(cadence)).toBe(cron));
});

describe("nextFire", () => {
  it("daily 09:00 in Kolkata is 03:30Z, and the next day's once that has passed", () => {
    expect(iso(nextFire(daily9, KOLKATA, ms("2026-11-11T00:00:00Z")))).toBe("2026-11-11T03:30:00.000Z");
    expect(iso(nextFire(daily9, KOLKATA, ms("2026-11-11T03:30:00Z")))).toBe("2026-11-12T03:30:00.000Z");
  });

  it("daily 09:00 in New York moves an hour earlier in UTC when daylight saving starts", () => {
    const first = nextFire(daily9, NEW_YORK, ms("2026-03-07T00:00:00Z"));
    expect(iso(first)).toBe("2026-03-07T14:00:00.000Z");
    expect(iso(nextFire(daily9, NEW_YORK, first))).toBe("2026-03-08T13:00:00.000Z");
  });

  it("weekly on Monday, from a Wednesday, is the next Monday", () => {
    expect(iso(nextFire({ kind: "weekly", day: "mon", time: "09:00" }, KOLKATA, ms("2026-11-11T06:00:00Z")))).toBe("2026-11-16T03:30:00.000Z");
  });

  it("weekdays skip the weekend", () => {
    expect(iso(nextFire({ kind: "weekdays", time: "09:00" }, "UTC", ms("2026-11-13T10:00:00Z")))).toBe("2026-11-16T09:00:00.000Z");
  });

  it("every 6 hours at :15 fires at 00:15, 06:15, 12:15 and 18:15 local", () => {
    expect(iso(nextFire({ kind: "hours", every: 6, minute: 15 }, KOLKATA, ms("2026-11-11T01:00:00Z")))).toBe("2026-11-11T06:45:00.000Z");
    expect(iso(nextFire({ kind: "hours", every: 6, minute: 15 }, KOLKATA, ms("2026-11-11T13:00:00Z")))).toBe("2026-11-11T18:45:00.000Z");
  });
});

describe("prevFire", () => {
  it("is the latest fire at or before the time", () => {
    expect(iso(prevFire(daily9, KOLKATA, ms("2026-11-11T03:31:00Z")))).toBe("2026-11-11T03:30:00.000Z");
    expect(iso(prevFire(daily9, KOLKATA, ms("2026-11-11T03:30:00Z")))).toBe("2026-11-11T03:30:00.000Z");
    expect(iso(prevFire(daily9, KOLKATA, ms("2026-11-11T03:29:00Z")))).toBe("2026-11-10T03:30:00.000Z");
  });
});

describe("fireAt", () => {
  const now = ms("2026-11-11T03:31:10Z");
  it("takes Scheduler's scheduled time, floored to the minute", () => {
    expect(fireAt("2026-11-11T03:30:27Z", daily9, KOLKATA, now)).toBe("2026-11-11T03:30:00.000Z");
  });
  it.each(["<aws.scheduler.scheduled-time>", undefined, "Nov 11 2026"])("falls back to the last fire for %j", (at) => {
    expect(fireAt(at, daily9, KOLKATA, now)).toBe("2026-11-11T03:30:00.000Z");
  });
});

describe("threadNameFor", () => {
  it("is the title's slug and the date in the room's zone", () => {
    expect(threadNameFor("Morning digest!", ms("2026-11-10T03:30:00Z"), KOLKATA)).toBe("morning-digest-nov-10");
    expect(threadNameFor("Late", ms("2026-11-10T20:00:00Z"), KOLKATA)).toBe("late-nov-11");
  });
  it("fits a thread name and has a letter", () => {
    expect(threadNameFor("A very long schedule title that goes on", ms("2026-11-10T03:30:00Z"), KOLKATA)).toBe("a-very-long-schedule-titl-nov-10");
    expect(threadNameFor("☀️ 42", ms("2026-11-10T03:30:00Z"), KOLKATA)).toBe("42-nov-10");
    expect(threadNameFor("!!!", ms("2026-11-10T03:30:00Z"), KOLKATA)).toBe("schedule-nov-10");
  });
});
