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
