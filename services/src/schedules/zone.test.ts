import { describe, expect, it } from "vitest";
import { fromZoned, roomTimeZone, zonedParts } from "./zone.js";

describe("roomTimeZone", () => {
  // ICU would report Asia/Kolkata as Asia/Calcutta; the name must reach Scheduler as given.
  it.each(["Asia/Kolkata", "UTC", "America/New_York"])("keeps %j as given", (zone) => expect(roomTimeZone(zone)).toBe(zone));

  it("trims the name", () => expect(roomTimeZone(" Europe/London ")).toBe("Europe/London"));

  it.each(["Mars/Base", "utc", "asia/kolkata", "", 5, undefined])("refuses %j", (raw) => {
    expect(() => roomTimeZone(raw)).toThrow("Unknown time zone.");
  });
});

describe("zonedParts", () => {
  it("reads the wall clock in the zone", () => {
    expect(zonedParts(Date.parse("2026-11-10T20:00:00Z"), "Asia/Kolkata")).toEqual({ y: 2026, mo: 11, d: 11, h: 1, mi: 30 });
  });
});

describe("fromZoned", () => {
  it("turns a wall-clock time into an instant", () => {
    expect(new Date(fromZoned({ y: 2026, mo: 11, d: 11, h: 9, mi: 0 }, "Asia/Kolkata")).toISOString()).toBe("2026-11-11T03:30:00.000Z");
  });

  it("follows daylight saving time", () => {
    const nineInNewYork = (d: number) => new Date(fromZoned({ y: 2026, mo: 3, d, h: 9, mi: 0 }, "America/New_York")).toISOString();
    expect(nineInNewYork(7)).toBe("2026-03-07T14:00:00.000Z");
    expect(nineInNewYork(8)).toBe("2026-03-08T13:00:00.000Z");
  });

  it("moves a time the clocks skip one hour later, and takes the first of a time they repeat", () => {
    expect(new Date(fromZoned({ y: 2026, mo: 3, d: 8, h: 2, mi: 30 }, "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(fromZoned({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});
