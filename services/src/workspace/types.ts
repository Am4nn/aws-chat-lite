export type FileAuthor = { kind: "member"; userId: string; name: string } | { kind: "thread"; threadId: string; number: number };
export type RoomFile = { path: string; size: number; contentType: string; v: number; updatedAt: string; updatedBy: FileAuthor };
/** objectKey never leaves the server. */
export type StoredFile = RoomFile & { objectKey: string };
/** What a sandbox session last synced with the room: the room version and content hash of each path. */
export type Manifest = Record<string, { v: number; sha256: string }>;
/** A long list ends with an "…and N more" entry. */
export type FilesSynced = { written: string[]; deleted: string[]; notes: string[] };
/**
 * Tells the room's members which files changed, so no client has to refetch the list; a change too big for one
 * socket message asks them to refetch instead.
 */
export type FilesUpdated =
  | { type: "files.updated"; roomId: string; files: RoomFile[]; deleted: string[] }
  | { type: "files.updated"; roomId: string; refetch: true };
