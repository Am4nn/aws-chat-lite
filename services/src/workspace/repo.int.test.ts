import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { roomKey } from "../lib/keys.js";
import { roomsRepo } from "../rooms/repo.js";
import { MAX_ROOM_FILES, OVER_QUOTA, ROOM_FILES_BYTES, TOO_MANY } from "./limits.js";
import { QuotaError, workspaceRepo } from "./repo.js";
import type { FileAuthor } from "./types.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const files = workspaceRepo();
const rooms = roomsRepo();
const by: FileAuthor = { kind: "member", userId: "u1", name: "aman" };

async function newRoom() {
  const owner = { userId: randomUUID(), username: "owner" };
  const { roomId } = await rooms.createRoom(owner, "Files");
  return { roomId, owner };
}

const put = (roomId: string, path: string, size: number) =>
  files.commit(roomId, { path, objectKey: `workspaces/${roomId}/${randomUUID()}`, size, contentType: "text/plain", by });

/** Sets the room's counters directly, as if it already held that much. */
const setUsage = (roomId: string, values: { filesBytes?: number; filesCount?: number }) => {
  const names = Object.keys(values);
  return docClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: roomKey(roomId), sk: "META" },
    UpdateExpression: `SET ${names.map((n) => `${n} = :${n}`).join(", ")}`,
    ExpressionAttributeValues: Object.fromEntries(names.map((n) => [`:${n}`, values[n as keyof typeof values]])),
  }));
};

describe("workspace repo on Floci", () => {
  it("a new file is v1 and counts once; the same path again is v2 and counts only its new size", async () => {
    const { roomId } = await newRoom();
    const first = await put(roomId, "a.txt", 5);
    expect(first.file).toMatchObject({ path: "a.txt", size: 5, v: 1, updatedBy: by });
    expect(first.replaced).toBeUndefined();
    expect(await files.usage(roomId)).toEqual({ bytes: 5, count: 1 });

    const second = await put(roomId, "a.txt", 3);
    expect(second.file.v).toBe(2);
    expect(second.replaced).toMatchObject({ v: 1, objectKey: first.file.objectKey });
    expect(await files.usage(roomId)).toEqual({ bytes: 3, count: 1 });
    expect(await files.get(roomId, "a.txt")).toEqual(second.file);
  });

  it("two commits racing for the last 10 bytes: exactly one is refused for quota", async () => {
    const { roomId } = await newRoom();
    await setUsage(roomId, { filesBytes: ROOM_FILES_BYTES - 10 });
    const results = await Promise.allSettled([put(roomId, "x", 6), put(roomId, "y", 6)]);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(QuotaError);
    expect(refused[0]!.reason.message).toBe(OVER_QUOTA);
    expect(await files.usage(roomId)).toEqual({ bytes: ROOM_FILES_BYTES - 4, count: 1 });
  });

  it("at 1,000 files a new path is refused, while an overwrite still goes through", async () => {
    const { roomId } = await newRoom();
    await put(roomId, "a.txt", 5);
    await setUsage(roomId, { filesCount: MAX_ROOM_FILES });
    await expect(put(roomId, "b.txt", 5)).rejects.toThrow(TOO_MANY);
    expect((await put(roomId, "a.txt", 6)).file.v).toBe(2);
    expect(await files.usage(roomId)).toEqual({ bytes: 6, count: MAX_ROOM_FILES });
  });

  it("a remove expecting an older version keeps the newer one; one expecting the current version frees its space", async () => {
    const { roomId } = await newRoom();
    await put(roomId, "a.txt", 5);
    await put(roomId, "a.txt", 7);
    const kept = await files.remove(roomId, "a.txt", 1);
    expect(kept).toEqual({ kept: expect.objectContaining({ v: 2 }) });
    expect(await files.usage(roomId)).toEqual({ bytes: 7, count: 1 });

    const removed = await files.remove(roomId, "a.txt", 2);
    expect(removed).toEqual({ removed: expect.objectContaining({ v: 2, size: 7 }) });
    expect(await files.usage(roomId)).toEqual({ bytes: 0, count: 0 });
    expect(await files.remove(roomId, "a.txt")).toEqual({});
  });

  it("lists the room's files sorted by path", async () => {
    const { roomId } = await newRoom();
    for (const path of ["b", "a/c", "a.txt"]) await put(roomId, path, 1);
    expect((await files.list(roomId)).map((f) => f.path)).toEqual(["a.txt", "a/c", "b"]);
  });

  it("the room view shows the sandbox's internet off until an admin turns it on", async () => {
    const { roomId, owner } = await newRoom();
    expect((await rooms.getRoomView(roomId, owner.userId)).sandboxInternet).toBe(false);
    expect(await rooms.setSandboxInternet(owner, roomId, true)).toBe(true);
    expect((await rooms.getRoomView(roomId, owner.userId)).sandboxInternet).toBe(true);
  });
});
