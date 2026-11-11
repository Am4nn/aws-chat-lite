import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { roomsRepo } from "../rooms/repo.js";
import { queryAll } from "../lib/db.js";
import { deliver } from "./delivery/handler.js";
import { pushRepo } from "./repo.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const repo = pushRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });

/** A subscription as a browser makes one: a fresh P-256 key and auth secret. */
function device(n: number | string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}-${n}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

const pushed = (userId: string) => queryAll({
  KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ConsistentRead: true,
  ExpressionAttributeValues: { ":p": `USER#${userId}`, ":s": "PUSHED#" },
});

describe("push repo on Floci", () => {
  it("the same device saved twice is one subscription", async () => {
    const { userId } = user("aman");
    const sub = device(1);
    const first = await repo.save(userId, sub);
    expect(await repo.save(userId, sub)).toEqual(first);
    expect(await repo.forUsers([userId])).toEqual([expect.objectContaining({ id: first.id, userId, ...sub })]);
  });

  it("a browser saved by another user moves to them", async () => {
    const [before, after] = [user("aman"), user("bea")];
    const sub = device(1);
    const { id } = await repo.save(before.userId, sub);
    await repo.save(after.userId, sub);
    expect(await repo.forUsers([before.userId])).toEqual([]);
    expect(await repo.forUsers([after.userId])).toEqual([expect.objectContaining({ id, userId: after.userId })]);
  });

  it("an 11th device pushes out the one saved first", async () => {
    const { userId } = user("aman");
    const ids: string[] = [];
    for (let n = 0; n < 11; n++) ids.push((await repo.save(userId, device(n))).id);
    const kept = (await repo.forUsers([userId])).map((s) => s.id);
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain(ids[0]);
    expect(kept).toContain(ids[10]);
  });

  it("forUsers returns every listed user's devices", async () => {
    const [a, b] = [user("a"), user("b")];
    await repo.save(a.userId, device("a"));
    await repo.save(b.userId, device("b"));
    expect(new Set((await repo.forUsers([a.userId, b.userId])).map((s) => s.userId))).toEqual(new Set([a.userId, b.userId]));
  });

  it("remove forgets the device", async () => {
    const { userId } = user("aman");
    const { id } = await repo.save(userId, device(1));
    await repo.remove(userId, id);
    expect(await repo.forUsers([userId])).toEqual([]);
  });

  it("deliver, faked, records one note per device of each member it targets", async () => {
    const rooms = roomsRepo();
    const [owner, bea] = [user("aman"), user("bea")];
    const { roomId, generalChatId } = await rooms.createRoom(owner, "dev");
    await rooms.acceptInvite((await rooms.rotateInvite(roomId, owner.userId)).code, bea);
    await repo.save(owner.userId, device("phone"));
    await repo.save(owner.userId, device("laptop"));
    const outsider = user("cy");
    await repo.save(outsider.userId, device("cy"));
    await deliver({
      kind: "mention", roomId, chatId: generalChatId, seq: 1, authorName: "bea", text: "@aman hi", everyone: false,
      userIds: [owner.userId, outsider.userId],
    });
    const notes = await pushed(owner.userId);
    expect(notes).toHaveLength(2);
    expect(notes[0].note).toEqual({
      title: "bea mentioned you in #general", body: "dev: @aman hi", url: `/r/${roomId}/c/${generalChatId}`,
      tag: `chat-${generalChatId}`, urgency: "normal",
    });
    expect(await pushed(outsider.userId)).toEqual([]);
  });
});
