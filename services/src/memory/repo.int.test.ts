import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { docClient, tableName } from "../lib/db.js";
import { roomsRepo } from "../rooms/repo.js";
import { memoryRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int.
const user = (name: string) => ({ userId: randomUUID(), username: name });
const source = { kind: "agent" as const, agent: "scout", threadNumber: 3 };
const meta = (roomId: string) => ({ pk: `ROOM#${roomId}`, sk: "META" });

async function room() {
  const owner = user("owner");
  const member = user("bea");
  const rooms = roomsRepo();
  const { roomId } = await rooms.createRoom(owner, "Memory");
  await rooms.acceptInvite((await rooms.rotateInvite(roomId, owner.userId)).code, member);
  return { owner, member, roomId };
}

const setCount = (roomId: string, n: number) => docClient().send(new UpdateCommand({
  TableName: tableName(), Key: meta(roomId), UpdateExpression: "SET memoryCount = :n", ExpressionAttributeValues: { ":n": n },
}));
const count = async (roomId: string) =>
  (await docClient().send(new GetCommand({ TableName: tableName(), Key: meta(roomId), ConsistentRead: true }))).Item?.memoryCount;

describe("room memory on Floci", () => {
  it("saves entries with 8-hex ids and lists them newest first", async () => {
    const { owner, roomId } = await room();
    const repo = memoryRepo();
    const first = await repo.save(roomId, { text: "Deploys go out on Fridays.", private: false, source });
    const second = await repo.save(roomId, { text: "The design lead is Ana.", private: false, source });
    expect(first.memoryId).toMatch(/^[0-9a-f]{8}$/);
    expect(second).toMatchObject({ text: "The design lead is Ana.", private: false, source, updatedBy: "scout" });
    expect((await repo.list(owner, roomId)).map((e) => e.memoryId)).toEqual([second.memoryId, first.memoryId]);
    expect(await repo.entries(roomId)).toEqual(await repo.list(owner, roomId));
    expect(await count(roomId)).toBe(2);
  });

  it("refuses a save when the room holds 50 entries", async () => {
    const { roomId } = await room();
    await setCount(roomId, 50);
    await expect(memoryRepo().save(roomId, { text: "one more", private: false, source }))
      .rejects.toThrow("Room memory is full (50 entries). Forget or update one first.");
  });

  it("lets exactly one of two saves racing for the 50th slot in", async () => {
    const { roomId } = await room();
    await setCount(roomId, 49);
    const repo = memoryRepo();
    const results = await Promise.allSettled([
      repo.save(roomId, { text: "a", private: false, source }), repo.save(roomId, { text: "b", private: false, source }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count(roomId)).toBe(50);
  });

  it("a member's edit keeps a private entry private and records who edited it", async () => {
    const { member, roomId } = await room();
    const repo = memoryRepo();
    const saved = await repo.save(roomId, { text: "Acme renews in March.", private: true, source });
    const edited = await repo.edit(member, roomId, saved.memoryId, "Acme renews in April.");
    expect(edited).toMatchObject({ text: "Acme renews in April.", private: true, updatedBy: "bea", source });
    expect((await repo.entries(roomId))[0]).toEqual(edited);
  });

  it("an agent update from a tainted thread makes a public entry private for good", async () => {
    const { roomId } = await room();
    const repo = memoryRepo();
    const { memoryId } = await repo.save(roomId, { text: "Acme is a customer.", private: false, source });
    expect(await repo.update(roomId, memoryId, { text: "Acme pays $40k.", by: "scout", private: true })).toMatchObject({ private: true });
    expect(await repo.update(roomId, memoryId, { text: "Acme pays $45k.", by: "scout", private: false })).toMatchObject({ private: true });
  });

  it("a member's delete gives the slot back; outsiders and unknown ids are refused", async () => {
    const { member, roomId } = await room();
    const repo = memoryRepo();
    const { memoryId } = await repo.save(roomId, { text: "Temporary note.", private: false, source });
    await expect(repo.list(user("stranger"), roomId)).rejects.toThrow("Room not found.");
    await expect(repo.remove(user("stranger"), roomId, memoryId)).rejects.toThrow("Room not found.");
    await repo.remove(member, roomId, memoryId);
    expect(await repo.entries(roomId)).toEqual([]);
    expect(await count(roomId)).toBe(0);
    await expect(repo.forget(roomId, "x")).rejects.toThrow("No memory [x].");
    await expect(repo.update(roomId, "x", { text: "y", by: "scout" })).rejects.toThrow("No memory [x].");
    expect(await count(roomId)).toBe(0);
  });
});
