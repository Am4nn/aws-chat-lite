import type { MemoryEntry } from "../types";

export const MEMORY_MAX = 50;
export const MEMORY_CHARS = 280;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

/** Where a memory came from, or who changed it last once someone has. */
export function sourceLine(entry: MemoryEntry, now: number): string {
  if (entry.updatedAt !== entry.createdAt) return `edited by ${entry.updatedBy} · ${ago(entry.updatedAt, now)}`;
  const { source } = entry;
  const origin = source.kind === "agent" ? `@${source.agent} in #${source.threadNumber}` : source.username;
  return `${origin} · ${ago(entry.createdAt, now)}`;
}
