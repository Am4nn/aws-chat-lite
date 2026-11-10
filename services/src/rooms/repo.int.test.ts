import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { roomsRepo } from "./repo.js";
import { docClient, tableName } from "../lib/db.js";
import { Conflict, Forbidden, Gone, NotFound } from "./model.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const repo = roomsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });

describe("rooms repo on Floci", () => {
  it("createRoom writes the room, its owner and #general; listMyRooms finds it", async () => {
    const owner = user("owner");
    const { roomId } = await repo.createRoom(owner, "Dev Team");
    const view = await repo.getRoomView(roomId, owner.userId);
    expect(view.room.name).toBe("Dev Team");
    expect(view.me.role).toBe("owner");
    expect(view.chats.map((c) => c.name)).toEqual(["general"]);
    expect(view.members).toEqual([expect.objectContaining({ userId: owner.userId, role: "owner" })]);
    const mine = await repo.listMyRooms(owner.userId);
    expect(mine).toContainEqual(expect.objectContaining({ roomId, name: "Dev Team", role: "owner" }));
  });

  it("a non-member gets NotFound (never learns the room exists)", async () => {
    const { roomId } = await repo.createRoom(user("o"), "Secret");
    await expect(repo.getRoomView(roomId, randomUUID())).rejects.toBeInstanceOf(NotFound);
  });

  it("two concurrent creates of the same chat name: one wins, one Conflict", async () => {
    const owner = user("o");
    const { roomId } = await repo.createRoom(owner, "Race");
    const results = await Promise.allSettled([repo.createChat(roomId, owner.userId, "dup"), repo.createChat(roomId, owner.userId, "dup")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(Conflict);
    const view = await repo.getRoomView(roomId, owner.userId);
    expect(view.chats.filter((c) => c.name === "dup")).toHaveLength(1);
  });

  it("invites: accept joins as member once; accepting again keeps the role; members can't create chats", async () => {
    const owner = user("o");
    const b = user("b");
    const { roomId } = await repo.createRoom(owner, "Invites");
    const { code } = await repo.rotateInvite(roomId, owner.userId);
    const preview = await repo.previewInvite(code);
    expect(preview).toMatchObject({ roomName: "Invites", memberCount: 1 });

    await Promise.all([repo.acceptInvite(code, b), repo.acceptInvite(code, b)]);
    let view = await repo.getRoomView(roomId, b.userId);
    expect(view.members.filter((m) => m.userId === b.userId)).toHaveLength(1);
    expect(view.me.role).toBe("member");
    await expect(repo.createChat(roomId, b.userId, "nope")).rejects.toBeInstanceOf(Forbidden);

    await repo.setRole(roomId, owner.userId, b.userId, "admin");
    await repo.acceptInvite(code, b);
    view = await repo.getRoomView(roomId, b.userId);
    expect(view.me.role).toBe("admin");
    await repo.createChat(roomId, b.userId, "deploys");
  });

  it("revoked, rotated-away and expired links are Gone; unknown codes NotFound", async () => {
    const owner = user("o");
    const { roomId } = await repo.createRoom(owner, "Links");
    const first = await repo.rotateInvite(roomId, owner.userId);
    const second = await repo.rotateInvite(roomId, owner.userId);
    await expect(repo.acceptInvite(first.code, user("x"))).rejects.toBeInstanceOf(Gone);
    await repo.revokeInvite(roomId, owner.userId);
    await expect(repo.acceptInvite(second.code, user("y"))).rejects.toBeInstanceOf(Gone);
    await expect(repo.previewInvite("doesnotexist000000000a")).rejects.toBeInstanceOf(NotFound);

    const third = await repo.rotateInvite(roomId, owner.userId);
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `INVITE#${third.code}`, sk: "META" },
      UpdateExpression: "SET expiresAt = :p", ExpressionAttributeValues: { ":p": 1 },
    }));
    await expect(repo.acceptInvite(third.code, user("z"))).rejects.toBeInstanceOf(Gone);
  });

  it("permission checks and the room view read strongly consistently, so a join or removal counts at once", async () => {
    const owner = user("o");
    const { roomId } = await repo.createRoom(owner, "Consistent");
    const send = vi.spyOn(docClient(), "send");
    try {
      await repo.createChat(roomId, owner.userId, "reads");
      await repo.getRoomView(roomId, owner.userId);
      const sent = send.mock.calls.map(([command]) => command);
      const roleRead = sent.find((c) => c instanceof GetCommand && String(c.input.Key?.sk).startsWith("MEMBER#"));
      const viewQuery = sent.find((c) => c instanceof QueryCommand && !c.input.IndexName);
      expect((roleRead as GetCommand).input.ConsistentRead).toBe(true);
      expect((viewQuery as QueryCommand).input.ConsistentRead).toBe(true);
    } finally {
      send.mockRestore();
    }
  });

  it("concurrent rotates and revokes never leave more than one live link, and only the room's current one", async () => {
    const owner = user("o");
    const { roomId } = await repo.createRoom(owner, "Rotate race");
    await repo.rotateInvite(roomId, owner.userId);
    for (let round = 0; round < 5; round++) {
      const results = await Promise.allSettled([
        repo.rotateInvite(roomId, owner.userId), repo.rotateInvite(roomId, owner.userId), repo.revokeInvite(roomId, owner.userId),
      ]);
      const issued = results.flatMap((r) => (r.status === "fulfilled" && "code" in r.value ? [r.value.code] : []));
      const previews = await Promise.allSettled(issued.map((c) => repo.previewInvite(c)));
      const live = issued.filter((_, i) => previews[i].status === "fulfilled");
      const current = await repo.getInvite(roomId, owner.userId).then((i) => i.code, () => undefined);
      expect(live.filter((c) => c !== current), `round ${round}: live links the room can't revoke`).toEqual([]);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(Conflict);
      await repo.rotateInvite(roomId, owner.userId);
    }
  });

  it("the owner can't be removed or demoted; admins can't remove admins", async () => {
    const owner = user("o");
    const a = user("a");
    const a2 = user("a2");
    const { roomId } = await repo.createRoom(owner, "Roles");
    const { code } = await repo.rotateInvite(roomId, owner.userId);
    await repo.acceptInvite(code, a);
    await repo.acceptInvite(code, a2);
    await repo.setRole(roomId, owner.userId, a.userId, "admin");
    await repo.setRole(roomId, owner.userId, a2.userId, "admin");
    await expect(repo.removeMember(roomId, a.userId, owner.userId)).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.removeMember(roomId, a.userId, a2.userId)).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.setRole(roomId, owner.userId, owner.userId, "member")).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.setRole(roomId, a.userId, a2.userId, "member")).rejects.toBeInstanceOf(Forbidden);
    await repo.removeMember(roomId, owner.userId, a2.userId);
    await expect(repo.getRoomView(roomId, a2.userId)).rejects.toBeInstanceOf(NotFound);
  });
});
