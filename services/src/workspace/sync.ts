import type { ListedFile } from "../sandbox/sandbox.js";
import type { Listing } from "../sandbox/scripts.js";
import { MAX_ROOM_FILE_BYTES, MAX_ROOM_FILES, OVER_QUOTA, ROOM_FILES_BYTES, TOO_MANY } from "./limits.js";
import { pathClash, workspacePath } from "./paths.js";
import type { FileAuthor, Manifest, RoomFile } from "./types.js";

/**
 * Room files that changed since the session last synced, and the ones the room no longer has. Removes go first, so a
 * file can take the place of a folder the room dropped; a file that would land on a folder the sandbox still holds
 * is skipped with a note.
 */
export function pullPlan<F extends RoomFile>(index: F[], synced: Manifest): { write: F[]; remove: string[]; notes: string[] } {
  const inRoom = new Set(index.map((f) => f.path));
  const remove = Object.keys(synced).filter((path) => !inRoom.has(path));
  const held = Object.keys(synced).filter((path) => inRoom.has(path));
  const write: F[] = [];
  const notes: string[] = [];
  for (const f of index.filter((f) => f.v !== synced[f.path]?.v)) {
    const clash = pathClash(held, f.path);
    if (clash) notes.push(`${f.path} wasn't copied into the sandbox: it clashes with ${clash} there.`);
    else write.push(f);
  }
  return { write, remove, notes };
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

/**
 * What to save to the room and what to delete from it after a sandbox step; anything refused comes back as a note.
 * Deletes are applied first and counted against the limits first, so a rename in a full room keeps its file. A file
 * the listing couldn't read, or one in a folder it couldn't read, is neither saved nor deleted.
 */
export function pushPlan(
  listing: Listing,
  loaded: Manifest,
  known: (path: string) => number | undefined,
  index: Map<string, RoomFile>,
  usage: { bytes: number; count: number },
): { put: ListedFile[]; remove: { path: string; v: number }[]; notes: string[] } {
  const notes = [
    ...listing.badNames.map((name) => `${name} wasn't saved: its name isn't valid UTF-8.`),
    ...listing.unreadable.map((path) => `${path} wasn't saved: it couldn't be read.`),
  ];
  const listed = new Set(listing.files.map((f) => f.path));
  const locked = (path: string) => listing.unreadable.some((u) => path === u || path.startsWith(`${u}/`));
  // A file past the listing's cut would look deleted, so a listing cut short deletes nothing.
  if (listing.more) {
    notes.push(`${listing.more} more files weren't checked, because the working directory holds too many; this step's deletes weren't saved.`);
  }
  const remove = listing.more ? [] : Object.keys(loaded)
    .filter((path) => !listed.has(path) && !locked(path))
    .map((path) => ({ path, v: known(path)! }));

  let bytes = usage.bytes;
  let count = usage.count;
  const inRoom = new Set(index.keys());
  for (const { path, v } of remove) {
    const file = index.get(path);
    // A delete conditioned on an older version is skipped, so it frees nothing.
    if (file?.v !== v) continue;
    bytes -= file.size;
    count -= 1;
    inRoom.delete(path);
  }
  const roomPaths = [...inRoom];

  const put: ListedFile[] = [];
  const changed = listing.files.filter((f) => loaded[f.path]?.sha256 !== f.sha256).sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const file of changed) {
    const existing = index.get(file.path);
    const projected = bytes - (existing?.size ?? 0) + file.size;
    const usable = isUsableName(file.path);
    const clash = usable && pathClash(roomPaths, file.path);
    if (!usable) notes.push(`${file.path} wasn't saved: its name can't be used for a room file.`);
    else if (file.size > MAX_ROOM_FILE_BYTES) notes.push(`${file.path} (${megabytes(file.size)} MB) wasn't saved: room files are 25 MB at most.`);
    else if (clash) notes.push(`${file.path} wasn't saved: it clashes with ${clash} in the room files, and a file and a folder can't share a name.`);
    else if (projected > ROOM_FILES_BYTES) notes.push(quotaNote(file.path, OVER_QUOTA));
    else if (!existing && count + 1 > MAX_ROOM_FILES) notes.push(quotaNote(file.path, TOO_MANY));
    else {
      put.push(file);
      bytes = projected;
      if (!existing) count += 1;
    }
  }
  return { put, remove, notes };
}

export const authorWho = (by: FileAuthor): string => (by.kind === "member" ? `@${by.name}` : `#${by.number}`);

export const overwroteNote = (path: string, by: FileAuthor): string =>
  `${path} was changed by ${authorWho(by)} after this run loaded it; this run's version replaced it.`;

export const keptNote = (path: string, by: FileAuthor): string =>
  `${path} was changed by ${authorWho(by)} after this run loaded it, so this run's delete was skipped.`;
