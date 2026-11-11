export type FileAuthor = { kind: "member"; userId: string; name: string } | { kind: "thread"; threadId: string; number: number };
export type RoomFile = { path: string; size: number; contentType: string; v: number; updatedAt: string; updatedBy: FileAuthor };
/** objectKey never leaves the server. */
export type StoredFile = RoomFile & { objectKey: string };
/** What a sandbox session last synced with the room: the room version and content hash of each path. */
export type Manifest = Record<string, { v: number; sha256: string }>;
export type FilesSynced = { written: string[]; deleted: string[]; notes: string[] };
