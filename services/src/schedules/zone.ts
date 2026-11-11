import { ValidationError } from "../lib/errors.js";

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/** A wall-clock minute: month 1–12, hour 0–23. */
type WallClock = { y: number; mo: number; d: number; h: number; mi: number };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(tz: string) {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    formats.set(tz, format);
  }
  return format;
}

/**
 * Intl accepts any casing (`utc`, `asia/kolkata`), which Scheduler may refuse, so only exact IANA names pass. Node
 * lists a few zones under their old names (Asia/Calcutta), so the current ones are added.
 */
const ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC", "Asia/Kolkata"]);

/**
 * An exact zone name, kept as given: it is what Scheduler gets. ICU's resolved name would rewrite some zones to their
 * old names (Asia/Kolkata as Asia/Calcutta), so it is never used.
 */
export function roomTimeZone(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!ZONES.has(name)) throw new ValidationError("Unknown time zone.");
  return name;
}

export function zonedParts(ms: number, tz: string): WallClock {
  const part = Object.fromEntries(formatIn(tz).formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return { y: part.year, mo: part.month, d: part.day, h: part.hour, mi: part.minute };
}

/** How far the zone's wall clock is ahead of UTC at that instant. */
function offsetAt(ms: number, tz: string) {
  const { y, mo, d, h, mi } = zonedParts(ms, tz);
  return Date.UTC(y, mo - 1, d, h, mi) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant the zone's clock shows that wall-clock minute. A day holds at most one offset change, so the offsets a
 * day either side are the only candidates. A time the clocks skip moves one hour later (read with the earlier offset),
 * and a time they repeat takes its first occurrence.
 */
export function fromZoned(wall: WallClock, tz: string): number {
  const local = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi);
  const before = local - offsetAt(local - DAY_MS, tz);
  const after = local - offsetAt(local + DAY_MS, tz);
  const valid = [before, after].filter((t) => t + offsetAt(t, tz) === local);
  return valid.length ? Math.min(...valid) : before;
}
