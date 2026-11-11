import type { ListedFile } from "../sandbox/sandbox.js";
import { MAX_ROOM_FILE_BYTES, MAX_ROOM_FILES, OVER_QUOTA, ROOM_FILES_BYTES, TOO_MANY } from "./limits.js";
import { workspacePath } from "./paths.js";
import type { FileAuthor, Manifest, RoomFile } from "./types.js";

/** Room files that changed since the session last synced, and the ones the room no longer has. */
export function pullPlan<F extends RoomFile>(index: F[], synced: Manifest): { write: F[]; remove: string[] } {
  const inRoom = new Set(index.map((f) => f.path));
  return {
    write: index.filter((f) => f.v !== synced[f.path]?.v),
    remove: Object.keys(synced).filter((path) => !inRoom.has(path)),
  };
}

const megabytes = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);

function isUsableName(path: string): boolean {
  try {
    workspacePath(path);
    return true;
  } catch {
    return false;
  }
}

/** The note for a file the room's quota refused, from the refusal's message (`OVER_QUOTA` or `TOO_MANY`). */
export const quotaNote = (path: string, refusal: string): string =>
  refusal === TOO_MANY ? `${path} wasn't saved: a room keeps 1,000 files at most.` : `${path} wasn't saved: the room's files would pass 100 MB.`;

/** What to save to the room and what to delete from it after a sandbox step; anything refused comes back as a note. */
export function pushPlan(
  listing: ListedFile[],
  synced: Manifest,
  index: Map<string, RoomFile>,
  usage: { bytes: number; count: number },
): { put: ListedFile[]; remove: { path: string; v: number }[]; notes: string[] } {
  const listed = new Set(listing.map((f) => f.path));
  const changed = listing.filter((f) => synced[f.path]?.sha256 !== f.sha256).sort((a, b) => (a.path < b.path ? -1 : 1));
  const put: ListedFile[] = [];
  const notes: string[] = [];
  let bytes = usage.bytes;
  let count = usage.count;

  for (const file of changed) {
    const existing = index.get(file.path);
    const projected = bytes - (existing?.size ?? 0) + file.size;
    if (!isUsableName(file.path)) notes.push(`${file.path} wasn't saved: its name can't be used for a room file.`);
    else if (file.size > MAX_ROOM_FILE_BYTES) notes.push(`${file.path} (${megabytes(file.size)} MB) wasn't saved: room files are 25 MB at most.`);
    else if (projected > ROOM_FILES_BYTES) notes.push(quotaNote(file.path, OVER_QUOTA));
    else if (!existing && count + 1 > MAX_ROOM_FILES) notes.push(quotaNote(file.path, TOO_MANY));
    else {
      put.push(file);
      bytes = projected;
      if (!existing) count += 1;
    }
  }

  const remove = Object.entries(synced)
    .filter(([path]) => !listed.has(path))
    .map(([path, { v }]) => ({ path, v }));
  return { put, remove, notes };
}

export const authorWho = (by: FileAuthor): string => (by.kind === "member" ? `@${by.name}` : `#${by.number}`);

export const overwroteNote = (path: string, by: FileAuthor): string =>
  `${path} was changed by ${authorWho(by)} after this run loaded it; this run's version replaced it.`;

export const keptNote = (path: string, by: FileAuthor): string =>
  `${path} was changed by ${authorWho(by)} after this run loaded it, so this run's delete was skipped.`;
