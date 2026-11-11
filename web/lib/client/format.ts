import type { Budget } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** How long a step took: tenths of a second for quick ones, then whole seconds, then minutes. */
export function formatStepTime(ms: number): string {
  if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return formatElapsed(ms);
}

export function formatUsd(micros: number): string {
  if (micros > 0 && micros < 10_000) return "<$0.01";
  return `$${(Math.round(micros / 10_000) / 100).toFixed(2)}`;
}

/** The day the room's budget resets, which is the 1st of a month in UTC. */
export const resetsOn = (resetsAt: string) =>
  new Date(resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export const budgetFill = (b: Pick<Budget, "spentMicros" | "capMicros">) =>
  b.capMicros === 0 ? 100 : Math.min(100, (b.spentMicros / b.capMicros) * 100);

export function splitHeadline(text: string): { headline: string | null; body: string } {
  const i = text.indexOf("\n\n");
  if (i > 0 && i <= 120 && !text.slice(0, i).includes("\n")) return { headline: text.slice(0, i), body: text.slice(i + 2) };
  return { headline: null, body: text };
}

// A trailing partial word would flash and then change, so it waits for its space unless the text is final.
export function streamWords(text: string, final: boolean): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!final && words.length && !/\s$/.test(text)) words.pop();
  return words;
}

/** The streamed answer as paragraphs of words; only the last paragraph can still be mid-word. */
export function answerParagraphs(text: string, final: boolean): string[][] {
  const paragraphs = text.split(/\n\s*\n/);
  return paragraphs
    .map((p, i) => streamWords(p, final || i < paragraphs.length - 1))
    .filter((words) => words.length > 0);
}

/** Mirrors the server's wait copy, so the room's setting, the card and the model's "skipped" result read the same. */
export function formatWait(sec: number): string {
  if (sec < 60) return "under a minute";
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

export function typingText(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

/** The quote a reply shows, cut the way the server cuts it so a pending reply looks the same once stored. */
export function excerpt(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > 140 ? `${chars.slice(0, 140).join("")}…` : chars.join("");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function timeAgo(iso: string, now: number): string {
  const ago = now - Date.parse(iso);
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`;
  return `${Math.floor(ago / DAY)}d ago`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 ** 2 ? [bytes / 1024, "KB"] : [bytes / 1024 ** 2, "MB"];
  return `${Number(value.toFixed(1))} ${unit}`;
}

/** Where the browser leaves its time zone for the server's next render. */
export const TZ_COOKIE = "tz";

/**
 * Times render on the server and again in the browser, so both format with the reader's zone (passed in) and a fixed
 * locale. Newer ICU builds put a narrow no-break space before AM/PM; normalising it keeps Node and the browser in step.
 */
export const clockTime = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }).replace(/\u202f/g, " ");

export function dayKey(iso: string | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function dayLabel(iso: string, now: number, timeZone: string): string {
  const day = dayKey(iso, timeZone);
  if (day === dayKey(now, timeZone)) return "Today";
  if (day === dayKey(now - 86_400_000, timeZone)) return "Yesterday";
  const sameYear = day.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone,
  });
}

/** A compact timestamp for lists: the time for today, otherwise the date. */
export function shortWhen(iso: string, now: number, timeZone: string): string {
  if (dayKey(iso, timeZone) === dayKey(now, timeZone)) return clockTime(iso, timeZone);
  const sameYear = dayKey(iso, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone });
}

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;

/** A search result's text around its first match, so the match is always in view however long the message is. */
export function matchSnippet(text: string, query: string): { before: string; match: string; after: string } {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.trim().toLowerCase());
  if (at < 0 || !query.trim()) return { before: excerpt(flat), match: "", after: "" };
  const end = at + query.trim().length;
  const from = Math.max(0, at - SNIPPET_BEFORE);
  const to = Math.min(flat.length, end + SNIPPET_AFTER);
  return {
    before: `${from > 0 ? "…" : ""}${flat.slice(from, at)}`,
    match: flat.slice(at, end),
    after: `${flat.slice(end, to)}${to < flat.length ? "…" : ""}`,
  };
}
