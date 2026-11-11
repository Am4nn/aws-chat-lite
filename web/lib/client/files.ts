import type { FileAuthor, RoomFile, ThreadSummary } from "../types";

// Mirrors services/src/workspace/limits.ts. The server checks again on every write; these only answer sooner.
export const ROOM_FILES_BYTES = 104_857_600;
const MAX_ROOM_FILE_BYTES = 26_214_400;
const MAX_ROOM_FILES = 1000;
const TOO_BIG = "Room files are 25 MB at most.";
const OVER_QUOTA = "The room's files would pass 100 MB.";
const TOO_MANY = "A room keeps 1,000 files at most.";

/** Paths compare by code unit, not locale, because the room keeps them case-sensitive. */
const byPath = (a: RoomFile, b: RoomFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** An upload's own answer and the socket's update race each other, so an older version never replaces a newer one. */
export function applyFilesUpdate(files: RoomFile[], ev: { files: RoomFile[]; deleted: string[] }): RoomFile[] {
  const next = new Map(files.map((f) => [f.path, f]));
  for (const path of ev.deleted) next.delete(path);
  for (const f of ev.files) if (f.v > (next.get(f.path)?.v ?? 0)) next.set(f.path, f);
  return [...next.values()].sort(byPath);
}

export function authorLabel(by: FileAuthor, threads: ThreadSummary[]): string {
  if (by.kind === "member") return `@${by.name}`;
  const thread = threads.find((t) => t.threadId === by.threadId);
  return thread ? `#${by.number} ${thread.name}` : `#${by.number}`;
}

/**
 * Sorts picked files into new uploads, replacements to confirm and refusals, checking the room's limits in the
 * server's order. A replacement counts only its size difference, and the picked files count together. Of two picked
 * files with one name (from two folders), only the first is taken, since both would land on the same path.
 */
export function screenUploads(picked: { name: string; size: number }[], files: RoomFile[], usedBytes: number) {
  const sizes = new Map(files.map((f) => [f.path, f.size]));
  const result = { upload: [] as string[], replace: [] as string[], refused: [] as { name: string; why: string }[] };
  let bytes = usedBytes;
  let count = files.length;
  const seen = new Set<string>();
  for (const { name, size } of picked) {
    if (seen.has(name)) continue;
    seen.add(name);
    const existing = sizes.get(name);
    const projected = bytes - (existing ?? 0) + size;
    const why = size > MAX_ROOM_FILE_BYTES ? TOO_BIG
      : projected > ROOM_FILES_BYTES ? OVER_QUOTA
      : existing === undefined && count >= MAX_ROOM_FILES ? TOO_MANY
      : null;
    if (why) {
      result.refused.push({ name, why });
      continue;
    }
    bytes = projected;
    if (existing === undefined) count++;
    (existing === undefined ? result.upload : result.replace).push(name);
  }
  return result;
}

/** The files this thread's latest run wrote that are still the room's current version. */
export const runFiles = (files: RoomFile[], t: ThreadSummary): string[] => files
  .filter((f) => f.updatedBy.kind === "thread" && f.updatedBy.threadId === t.threadId && f.updatedAt >= (t.startedAt ?? ""))
  .map((f) => f.path);
