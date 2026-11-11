import { isAdmin, type Cadence, type Role, type Schedule, type Weekday } from "../types";

export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export const WEEKDAYS: { day: Weekday; name: string }[] = [
  { day: "mon", name: "Monday" }, { day: "tue", name: "Tuesday" }, { day: "wed", name: "Wednesday" }, { day: "thu", name: "Thursday" },
  { day: "fri", name: "Friday" }, { day: "sat", name: "Saturday" }, { day: "sun", name: "Sunday" },
];

const pad = (n: number) => String(n).padStart(2, "0");

export function cadenceLabel(c: Cadence): string {
  switch (c.kind) {
    case "hours": return `${c.every === 1 ? "Every hour" : `Every ${c.every} hours`} at :${pad(c.minute)}`;
    case "daily": return `Every day at ${c.time}`;
    case "weekdays": return `Weekdays at ${c.time}`;
    case "weekly": return `Every ${WEEKDAYS.find((w) => w.day === c.day)!.name} at ${c.time}`;
  }
}

/** The server works out `nextAt`; this shows it on the room's clock, which is the one the schedule keeps. */
export const nextLabel = (iso: string, timeZone: string) =>
  `next ${new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).replace(",", "")}`;

/** The form's cadence after the kind changes, keeping the minute and, between day-based kinds, the time of day. */
export function cadenceOfKind(c: Cadence, kind: Cadence["kind"]): Cadence {
  const minute = c.kind === "hours" ? c.minute : Number(c.time.slice(3));
  const time = c.kind === "hours" ? `09:${pad(c.minute)}` : c.time;
  switch (kind) {
    case "hours": return { kind, every: c.kind === "hours" ? c.every : 1, minute };
    case "daily":
    case "weekdays": return { kind, time };
    case "weekly": return { kind, day: c.kind === "weekly" ? c.day : "mon", time };
  }
}

/** Mirrors the server's rule, which remains the real check. */
export const canEditSchedule = (s: Schedule, me: { userId: string; role: Role }) => isAdmin(me.role) || s.createdBy === me.userId;
