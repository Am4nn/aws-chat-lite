import { ValidationError } from "../lib/errors.js";
import type { ThreadStatus } from "./types.js";

export const ARCHIVE_AFTER_SEC = 604_800;

export const PROVISIONAL = (n: number) => `thread-${n}`;

export const threadSk = (n: number) => `THREAD#${String(n).padStart(10, "0")}`;

const NAME = /^(?=.*[a-z])[a-z0-9-]{1,32}$/;

/** Thread name: lowercase a-z, 0-9 and dashes, 1–32 characters, with a letter so it can't be mistaken for a number. */
export function threadName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!NAME.test(name)) {
    throw new ValidationError("Thread names use a-z, 0-9 and dashes, 1 to 32 characters, with at least one letter.");
  }
  return name;
}

/** The name, then name-2 … name-9; the base is trimmed so the suffix still fits in 32 characters. */
export function uniqueCandidates(name: string): string[] {
  const rest = Array.from({ length: 8 }, (_, i) => `${name.slice(0, 30)}-${i + 2}`);
  return [name, ...rest];
}

/** A running thread is never archived, however long it has been quiet. */
export function isArchived(t: { status: ThreadStatus; lastActivityAt: string }, nowMs: number): boolean {
  return t.status !== "running" && nowMs - Date.parse(t.lastActivityAt) > ARCHIVE_AFTER_SEC * 1000;
}

/** `#12` or `#name` at the very start of a message; a tag later in the text is just text. */
export function leadingTag(text: string): { number: number } | { name: string } | null {
  const tag = /^#([a-z0-9-]{1,32})(?=\s|$)/i.exec(text)?.[1]?.toLowerCase();
  if (!tag) return null;
  if (/^\d+$/.test(tag)) return { number: Number(tag) };
  return NAME.test(tag) ? { name: tag } : null;
}

export function summaryLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
