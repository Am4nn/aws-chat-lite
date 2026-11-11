import { ValidationError } from "../lib/errors.js";
import type { Cadence, Weekday } from "../threads/types.js";
import { fromZoned, zonedParts } from "./zone.js";

const EVERY = [1, 2, 3, 4, 6, 8, 12] as const;
/** In `Date.getUTCDay()` order, so a weekday's index is its day number. */
const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Thread names are at most 32 characters, and the date suffix (`-nov-10`) takes up to 7. */
const SLUG_MAX = 25;
const SEARCH_DAYS = 8;

const badCadence = () => new ValidationError("Pick every 1, 2, 3, 4, 6, 8 or 12 hours, daily, weekdays or weekly.");

function timeOf(raw: unknown): string {
  if (typeof raw !== "string" || !TIME.test(raw)) throw new ValidationError("Times are HH:MM, 24-hour.");
  return raw;
}

/** A preset cadence, rebuilt from its known fields only. The presets are what keep a schedule hourly or slower. */
export function parseCadence(raw: unknown): Cadence {
  const c = (raw ?? {}) as Record<string, unknown>;
  switch (c.kind) {
    case "hours": {
      const every = EVERY.find((n) => n === c.every);
      const minute = c.minute;
      if (!every || typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) throw badCadence();
      return { kind: "hours", every, minute };
    }
    case "daily":
    case "weekdays":
      return { kind: c.kind, time: timeOf(c.time) };
    case "weekly": {
      const day = WEEKDAYS.find((d) => d === c.day);
      if (!day) throw badCadence();
      return { kind: "weekly", day, time: timeOf(c.time) };
    }
    default:
      throw badCadence();
  }
}

const hourMinute = (time: string) => time.split(":").map(Number) as [number, number];

/** Scheduler's six-field cron (minutes hours day-of-month month day-of-week year), read in the schedule's zone. */
export function cronOf(c: Cadence): string {
  if (c.kind === "hours") return `cron(${c.minute} 0/${c.every} * * ? *)`;
  const [h, mi] = hourMinute(c.time);
  if (c.kind === "daily") return `cron(${mi} ${h} * * ? *)`;
  const days = c.kind === "weekly" ? c.day.toUpperCase() : "MON-FRI";
  return `cron(${mi} ${h} ? * ${days} *)`;
}

/** The cadence's fires on one local calendar day, earliest first. `dayMs` is that day's midnight read as UTC. */
function firesOn(c: Cadence, tz: string, dayMs: number): number[] {
  const date = new Date(dayMs);
  const weekday = date.getUTCDay();
  const day = { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
  let times: [number, number][];
  if (c.kind === "hours") times = Array.from({ length: 24 / c.every }, (_, i) => [i * c.every, c.minute]);
  else if (c.kind === "weekdays" && (weekday === 0 || weekday === 6)) times = [];
  else if (c.kind === "weekly" && WEEKDAYS[weekday] !== c.day) times = [];
  else times = [hourMinute(c.time)];
  return times.map(([h, mi]) => fromZoned({ ...day, h, mi }, tz)).sort((a, b) => a - b);
}

/** Local calendar days from the one `ms` falls on, `step` days at a time, as midnights read as UTC. */
function daysFrom(ms: number, tz: string, step: 1 | -1) {
  const { y, mo, d } = zonedParts(ms, tz);
  return Array.from({ length: SEARCH_DAYS + 1 }, (_, i) => Date.UTC(y, mo - 1, d + i * step));
}

/** The first fire after `afterMs`, found on the zone's wall clock so a daylight saving change moves it as Scheduler does. */
export function nextFire(c: Cadence, tz: string, afterMs: number): number {
  for (const day of daysFrom(afterMs, tz, 1)) {
    const fire = firesOn(c, tz, day).find((t) => t > afterMs);
    if (fire !== undefined) return fire;
  }
  throw new Error(`No fire within ${SEARCH_DAYS} days.`);
}

export function prevFire(c: Cadence, tz: string, atOrBeforeMs: number): number {
  for (const day of daysFrom(atOrBeforeMs, tz, -1)) {
    const fire = firesOn(c, tz, day).filter((t) => t <= atOrBeforeMs).pop();
    if (fire !== undefined) return fire;
  }
  throw new Error(`No fire within ${SEARCH_DAYS} days.`);
}

/**
 * The occurrence a fire is for, which is what keys its once-only claim. Scheduler fills in the scheduled time, so a
 * retry of the same occurrence gets the same key. If the placeholder arrives unreplaced, the latest fire due by now
 * stands in.
 */
export function fireAt(at: unknown, c: Cadence, tz: string, nowMs: number): string {
  const ms = typeof at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(at) ? Date.parse(at) : NaN;
  const occurrence = Number.isNaN(ms) ? prevFire(c, tz, nowMs) : ms - (ms % 60_000);
  return new Date(occurrence).toISOString();
}

/** `morning-digest-nov-10`: the title as a thread name, dated in the room's zone. */
export function threadNameFor(title: string, ms: number, tz: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-/, "").slice(0, SLUG_MAX).replace(/-$/, "");
  const { mo, d } = zonedParts(ms, tz);
  return `${slug || "schedule"}-${MONTHS[mo - 1]}-${d}`;
}
