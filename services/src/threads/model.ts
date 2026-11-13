import { ValidationError } from "../lib/errors.js";
import type { TaintSource } from "../models/privacy.js";
import { DEAD_REASON } from "../runs/model.js";
import type { ThreadStatus, ThreadSummary } from "./types.js";

export const ARCHIVE_AFTER_SEC = 604_800;

export const provisionalName = (n: number) => `thread-${n}`;

/**
 * True for a `thread-<N>` name. Each new thread takes one as its provisional name, so chats and renames may not
 * claim them first.
 */
export const isNumberedName = (name: string) => /^thread-\d+$/.test(name);

/** A name a person picked for a chat or a thread, refused when it is one the numbered threads keep. */
export function claimableName(name: string): string {
  if (isNumberedName(name)) throw new ValidationError("Names like thread-12 are kept for numbered threads.");
  return name;
}

export const threadSk = (n: number) => `THREAD#${String(n).padStart(10, "0")}`;

const NAME = /^(?=.*[a-z])[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * A model's suggested name as a slug: anything but a-z and 0-9 becomes one dash, with none at either end, cut to fit.
 * Models wrap names in quotes, bullets or sentence punctuation however they're asked.
 */
export function slugName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "");
}

/**
 * Thread name: lowercase a-z, 0-9 and dashes, 1–32 characters, starting and ending with a letter or digit, with a
 * letter so it can't be mistaken for a number.
 */
export function threadName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!NAME.test(name)) {
    throw new ValidationError("Thread names use a-z, 0-9 and dashes, 1 to 32 characters, with at least one letter.");
  }
  return name;
}

/**
 * The name, then name-2 … name-9; the base is trimmed so the suffix still fits in 32 characters, and a trimmed
 * candidate that lost the name's only letter is left out.
 */
export function uniqueCandidates(name: string): string[] {
  const rest = Array.from({ length: 8 }, (_, i) => `${name.slice(0, 30).replace(/-+$/, "")}-${i + 2}`);
  return [name, ...rest].filter((n) => NAME.test(n));
}

/** A thread with a live run, running or waiting on an approval, is never archived, however long it has been quiet. */
export function isArchived(t: { status: ThreadStatus; lastActivityAt: string }, nowMs: number): boolean {
  return t.status !== "running" && t.status !== "waiting" && nowMs - Date.parse(t.lastActivityAt) > ARCHIVE_AFTER_SEC * 1000;
}

/**
 * A stored thread as clients get it: the bookkeeping fields stay on the server, `archived` is worked out now, and the
 * taint, stored as a string set (which DynamoDB can only add to, and which has no order), becomes a sorted list. A
 * live run past its `deadAt` died without closing, so it shows as failed until the next message replaces it. That holds
 * for a waiting one too: its `deadAt` lies past the approval's expiry, which would have woken a live run. A thread
 * stored without an agent is answered by the built-in `@agent`.
 */
export function summary(
  { pk: _pk, sk: _sk, activeRunId: _run, named: _named, from: _from, taint, ...rest }: Record<string, unknown>, nowMs: number,
): ThreadSummary {
  let thread = rest as Omit<ThreadSummary, "archived" | "taint">;
  if ((thread.status === "running" || thread.status === "waiting") && nowMs > Date.parse(thread.deadAt ?? "")) {
    const { currentStep: _step, approval: _approval, ...dead } = thread;
    thread = { ...dead, status: "failed", summary: DEAD_REASON };
  }
  return { ...thread, taint: [...((taint as Set<TaintSource> | undefined) ?? [])].sort(), archived: isArchived(thread, nowMs) };
}

export function summaryLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  // By code point, so an emoji at the cut isn't split in half.
  const chars = Array.from(line);
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : line;
}
