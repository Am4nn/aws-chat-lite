import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { Forbidden, NotFound, ValidationError } from "../lib/errors.js";
import { roomKey } from "../lib/keys.js";
import { roomsRepo } from "../rooms/repo.js";
import { schedulesRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const repo = schedulesRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });
const daily9 = { kind: "daily", time: "09:00" } as const;

/** A room with an owner, an admin and two members, `#general`, and an agent `scout` (stored as the agents repo stores one). */
async function room() {
  const [owner, admin, member, other] = [user("owner"), user("admin"), user("member"), user("other")];
  const rooms = roomsRepo();
  const { roomId, generalChatId: chatId } = await rooms.createRoom(owner, "Schedules");
  const { code } = await rooms.rotateInvite(roomId, owner.userId);
  for (const u of [admin, member, other]) await rooms.acceptInvite(code, u);
  await rooms.setRole(roomId, owner.userId, admin.userId, "admin");
  await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: roomKey(roomId), sk: "AGENT#scout", agentId: "scout", name: "scout" } }));
  const input = { agentId: "scout", title: "Morning digest", prompt: "Digest the new issues.", cadence: daily9, chatId };
  return { owner, admin, member, other, roomId, chatId, input };
}

async function meta(roomId: string) {
  const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: roomKey(roomId), sk: "META" }, ConsistentRead: true }));
  return Item!;
}

const setCount = (roomId: string, n: number) => docClient().send(new UpdateCommand({
  TableName: tableName(), Key: { pk: roomKey(roomId), sk: "META" }, UpdateExpression: "SET scheduleCount = :n", ExpressionAttributeValues: { ":n": n },
}));

describe("schedules repo on Floci", () => {
  it("a member creates a schedule; the list shows it with its next fire in the room's zone", async () => {
    const { member, roomId, input } = await room();
    const created = await repo.create(member, roomId, input);
    expect(created).toMatchObject({ ...input, enabled: true, createdBy: member.userId, createdByName: "member" });
    const { schedules, timeZone, max } = await repo.list(member, roomId);
    expect({ timeZone, max }).toEqual({ timeZone: "Asia/Kolkata", max: 5 });
    expect(schedules).toEqual([created]);
    expect(created.nextAt).toMatch(/T03:30:00\.000Z$/);
    expect(await repo.get(roomId, created.scheduleId)).toMatchObject({ title: "Morning digest", enabled: true });
    expect((await meta(roomId)).scheduleCount).toBe(1);
  });

  it("refuses a bad title, an unknown chat, or a missing or deleted agent; the built-in agent is fine", async () => {
    const { member, roomId, input } = await room();
    await expect(repo.create(member, roomId, { ...input, title: "x".repeat(41) })).rejects.toThrow(new ValidationError("Schedule titles are 1 to 40 characters."));
    await expect(repo.create(member, roomId, { ...input, chatId: randomUUID() })).rejects.toThrow(new NotFound("Chat not found."));
    await expect(repo.create(member, roomId, { ...input, agentId: "nobody" })).rejects.toThrow(new NotFound("No such agent."));
    await docClient().send(new PutCommand({ TableName: tableName(), Item: { pk: roomKey(roomId), sk: "AGENT#gone", agentId: "gone", deleted: true } }));
    await expect(repo.create(member, roomId, { ...input, agentId: "gone" })).rejects.toThrow(new NotFound("No such agent."));
    expect((await meta(roomId)).scheduleCount ?? 0).toBe(0);
    await expect(repo.create(member, roomId, { ...input, agentId: "agent" })).resolves.toMatchObject({ agentId: "agent" });
  });

  it("two creates at 4 schedules: one wins, the other hits the cap", async () => {
    const { member, roomId, input } = await room();
    await setCount(roomId, 4);
    const results = await Promise.allSettled([repo.create(member, roomId, input), repo.create(member, roomId, input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [refused] = results.filter((r) => r.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toEqual(new ValidationError("A room has at most 5 schedules."));
    expect((await meta(roomId)).scheduleCount).toBe(5);
  });

  it("another member can't change or delete your schedule; an admin can", async () => {
    const { member, other, admin, roomId, input } = await room();
    const { scheduleId } = await repo.create(member, roomId, input);
    const refusal = new Forbidden("Only its creator or an admin can change this schedule.");
    await expect(repo.update(other, roomId, scheduleId, { title: "Mine now" })).rejects.toThrow(refusal);
    await expect(repo.remove(other, roomId, scheduleId)).rejects.toThrow(refusal);
    const updated = await repo.update(admin, roomId, scheduleId, { title: "Evening digest", cadence: { kind: "weekdays", time: "18:30" }, enabled: false });
    expect(updated).toMatchObject({ title: "Evening digest", cadence: { kind: "weekdays", time: "18:30" }, enabled: false, createdBy: member.userId });
    expect(updated.nextAt).toBeUndefined();
    expect((await repo.list(member, roomId)).schedules).toEqual([updated]);
    await repo.remove(member, roomId, scheduleId);
    expect(await repo.get(roomId, scheduleId)).toBeNull();
    expect((await meta(roomId)).scheduleCount).toBe(0);
    await expect(repo.update(member, roomId, scheduleId, { enabled: true })).rejects.toThrow(new NotFound("No such schedule."));
  });

  it("claims each occurrence once", async () => {
    const { member, roomId, input } = await room();
    const { scheduleId } = await repo.create(member, roomId, input);
    expect(await repo.claimFire(roomId, scheduleId, "2026-11-11T03:30:00.000Z")).toBe(true);
    expect(await repo.claimFire(roomId, scheduleId, "2026-11-11T03:30:00.000Z")).toBe(false);
    expect(await repo.claimFire(roomId, scheduleId, "2026-11-12T03:30:00.000Z")).toBe(true);
  });

  it("records a run and switches a schedule off", async () => {
    const { member, roomId, input } = await room();
    const { scheduleId } = await repo.create(member, roomId, input);
    await repo.recordRun(roomId, scheduleId, { at: "2026-11-11T03:30:00.000Z", threadNumber: 3 });
    await repo.setEnabled(roomId, scheduleId, false);
    expect(await repo.get(roomId, scheduleId)).toMatchObject({ enabled: false, lastRun: { at: "2026-11-11T03:30:00.000Z", threadNumber: 3 } });
    await repo.remove(member, roomId, scheduleId);
    await expect(repo.setEnabled(roomId, scheduleId, false)).resolves.toBeUndefined();
    expect(await repo.get(roomId, scheduleId)).toBeNull();
  });

  it("removeForAgent deletes only that agent's schedules and drops the count", async () => {
    const { member, roomId, input } = await room();
    const a = await repo.create(member, roomId, input);
    const b = await repo.create(member, roomId, input);
    const kept = await repo.create(member, roomId, { ...input, agentId: "agent" });
    expect((await repo.removeForAgent(roomId, "scout")).sort()).toEqual([a.scheduleId, b.scheduleId].sort());
    expect((await repo.list(member, roomId)).schedules.map((s) => s.scheduleId)).toEqual([kept.scheduleId]);
    expect((await meta(roomId)).scheduleCount).toBe(1);
  });

  it("createCopies fills the room up to the cap, switched off", async () => {
    const { member, owner, roomId, chatId, input } = await room();
    await setCount(roomId, 4);
    const copy = { ...input, createdBy: owner.userId, createdByName: "owner" };
    expect(await repo.createCopies(roomId, [copy, { ...copy, title: "Second" }], chatId)).toEqual({ copied: 1, skipped: 1 });
    const { schedules } = await repo.list(member, roomId);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ title: "Morning digest", enabled: false, chatId, createdBy: owner.userId });
    expect(schedules[0].nextAt).toBeUndefined();
  });

  it("only an admin sets the time zone, stored as given; it defaults to Asia/Kolkata", async () => {
    const { member, admin, roomId } = await room();
    expect(await repo.timeZoneOf(roomId)).toBe("Asia/Kolkata");
    await expect(repo.setTimeZone(member, roomId, "Europe/London")).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.setTimeZone(admin, roomId, "Mars/Base")).rejects.toThrow(new ValidationError("Unknown time zone."));
    expect(await repo.setTimeZone(admin, roomId, "America/New_York")).toBe("America/New_York");
    expect(await repo.timeZoneOf(roomId)).toBe("America/New_York");
    expect(await repo.setTimeZone(admin, roomId, "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(await repo.timeZoneOf(roomId)).toBe("Asia/Kolkata");
  });

  it("a non-member sees no schedules", async () => {
    const { roomId } = await room();
    await expect(repo.list(user("stranger"), roomId)).rejects.toBeInstanceOf(NotFound);
  });
});
