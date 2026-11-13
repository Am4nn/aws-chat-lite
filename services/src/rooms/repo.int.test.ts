import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { roomDirectory, roomsRepo } from "./repo.js";
import { threadsRepo } from "../threads/repo.js";
import { chatRepo } from "../chat/repo.js";
import { markConnected } from "../live/presence.js";
import { docClient, tableName } from "../lib/db.js";
import { Conflict, Forbidden, Gone, NotFound, ValidationError } from "../lib/errors.js";

// Runs against DynamoDB on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const repo = roomsRepo();
const user = (name: string) => ({ userId: randomUUID(), username: name });

/** A room with its owner and one member who joined through the invite link. */
async function roomWithMember() {
  const owner = user("owner");
  const member = user("member");
  const { roomId, generalChatId } = await repo.createRoom(owner, "Pair");
  await repo.acceptInvite((await repo.rotateInvite(roomId, owner.userId)).code, member);
  return { owner, member, roomId, generalChatId };
}

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

  it("the room view has the default model, Auto until an admin sets one, and the picker's options", async () => {
    const { owner, member, roomId } = await roomWithMember();
    expect(await repo.getRoomView(roomId, member.userId)).toMatchObject({ defaultModel: "auto" });
    await expect(repo.setDefaultModel(member, roomId, "haiku")).rejects.toBeInstanceOf(Forbidden);
    await repo.setRole(roomId, owner.userId, member.userId, "admin");
    expect(await repo.setDefaultModel(member, roomId, "haiku")).toBe("haiku");
    const view = await repo.getRoomView(roomId, owner.userId);
    expect(view.defaultModel).toBe("haiku");
    expect(view.models.map((m) => m.pick)).toEqual(["auto", "sonnet", "haiku", "opus", "fable", "deepseek-flash", "deepseek-pro"]);
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

  it("an admin renames a chat, #general included: the old name frees up, a chat's or thread's name is taken, a member can't", async () => {
    const { owner, member, roomId, generalChatId } = await roomWithMember();
    const { chatId } = await repo.createChat(roomId, owner.userId, "random");
    await threadsRepo().createThread(owner, roomId, { text: "check it", clientId: "k-rename", name: "pr-check" });
    expect(await repo.renameChat(roomId, owner.userId, chatId, "Off-Topic")).toEqual({ chatId, name: "off-topic" });
    expect(await repo.renameChat(roomId, owner.userId, generalChatId, "lobby")).toEqual({ chatId: generalChatId, name: "lobby" });
    await expect(repo.renameChat(roomId, owner.userId, chatId, "lobby")).rejects.toEqual(new Conflict("#lobby already exists."));
    await expect(repo.renameChat(roomId, owner.userId, chatId, "pr-check")).rejects.toEqual(new Conflict("#pr-check already exists."));
    await expect(repo.renameChat(roomId, member.userId, chatId, "mine")).rejects.toBeInstanceOf(Forbidden);
    expect((await repo.createChat(roomId, owner.userId, "random")).name).toBe("random");
    expect((await repo.getRoomView(roomId, member.userId)).chats.map((c) => c.name)).toEqual(["lobby", "off-topic", "random"]);
  });

  it("two renames to one name at once: one wins, one Conflict", async () => {
    const { owner, roomId } = await roomWithMember();
    const a = await repo.createChat(roomId, owner.userId, "a");
    const b = await repo.createChat(roomId, owner.userId, "b");
    const results = await Promise.allSettled([a, b].map((c) => repo.renameChat(roomId, owner.userId, c.chatId, "same")));
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const names = (await repo.getRoomView(roomId, owner.userId)).chats.map((c) => c.name).sort();
    expect(names.filter((n) => n === "same")).toHaveLength(1);
  });

  it("archiving a chat: admins only, flagged in the view, unarchived again; the first chat and a thread are refused", async () => {
    const { owner, member, roomId, generalChatId } = await roomWithMember();
    const { chatId } = await repo.createChat(roomId, owner.userId, "old");
    await expect(repo.setChatArchived(roomId, member.userId, chatId, true)).rejects.toBeInstanceOf(Forbidden);
    expect(await repo.setChatArchived(roomId, owner.userId, chatId, true)).toEqual({ chatId, archived: true });
    expect((await repo.getRoomView(roomId, member.userId)).chats.map((c) => [c.name, c.archived])).toEqual([["general", false], ["old", true]]);
    await expect(repo.setChatArchived(roomId, owner.userId, generalChatId, true)).rejects.toBeInstanceOf(ValidationError);
    const { thread } = await threadsRepo().createThread(owner, roomId, { text: "hi", clientId: "k-archive" });
    await expect(repo.setChatArchived(roomId, owner.userId, thread.threadId, true)).rejects.toBeInstanceOf(NotFound);
    await repo.setChatArchived(roomId, owner.userId, chatId, false);
    expect((await repo.getRoomView(roomId, owner.userId)).chats.every((c) => !c.archived)).toBe(true);
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
      const viewQueries = sent.filter((c) => c instanceof QueryCommand && !c.input.IndexName) as QueryCommand[];
      expect((roleRead as GetCommand).input.ConsistentRead).toBe(true);
      expect(viewQueries.length).toBeGreaterThan(0);
      for (const q of viewQueries) expect(q.input.ConsistentRead).toBe(true);
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

  it("members can't see, rotate or revoke the invite link", async () => {
    const owner = user("o");
    const m = user("m");
    const { roomId } = await repo.createRoom(owner, "Member invites");
    const { code } = await repo.rotateInvite(roomId, owner.userId);
    await repo.acceptInvite(code, m);
    await expect(repo.getInvite(roomId, m.userId)).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.rotateInvite(roomId, m.userId)).rejects.toBeInstanceOf(Forbidden);
    await expect(repo.revokeInvite(roomId, m.userId)).rejects.toBeInstanceOf(Forbidden);
  });

  it("a role change for someone removed mid-request is NotFound, not a server error", async () => {
    const owner = user("o");
    const m = user("m");
    const { roomId } = await repo.createRoom(owner, "Role race");
    await repo.acceptInvite((await repo.rotateInvite(roomId, owner.userId)).code, m);
    const client = docClient();
    const realSend = client.send.bind(client);
    // The removal lands between setRole's read of the target and its update.
    const send = vi.spyOn(client, "send").mockImplementation((async (command: unknown) => {
      if (command instanceof UpdateCommand) {
        await realSend(new DeleteCommand({ TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: `MEMBER#${m.userId}` } }));
      }
      return realSend(command as never);
    }) as never);
    try {
      await expect(repo.setRole(roomId, owner.userId, m.userId, "admin")).rejects.toBeInstanceOf(NotFound);
    } finally {
      send.mockRestore();
    }
  });

  it("revoking a link the table already expired doesn't leave an item that never expires", async () => {
    const owner = user("o");
    const { roomId } = await repo.createRoom(owner, "TTL");
    const { code } = await repo.rotateInvite(roomId, owner.userId);
    // What DynamoDB's TTL sweep does a day after the link expires.
    await docClient().send(new DeleteCommand({ TableName: tableName(), Key: { pk: `INVITE#${code}`, sk: "META" } }));
    await repo.revokeInvite(roomId, owner.userId);
    const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: { pk: `INVITE#${code}`, sk: "META" } }));
    expect(Item === undefined || typeof Item.ttl === "number").toBe(true);
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

  it("a member can leave, taking their socket subscriptions with them; the owner can't", async () => {
    const { owner, member, roomId } = await roomWithMember();
    const subscription = { pk: `ROOM#${roomId}`, sk: `CONN#${randomUUID()}`, userId: member.userId };
    await docClient().send(new PutCommand({ TableName: tableName(), Item: subscription }));
    await expect(repo.leaveRoom(roomId, owner.userId)).rejects.toBeInstanceOf(Forbidden);
    expect(await repo.leaveRoom(roomId, member.userId)).toEqual({});
    await expect(repo.getRoomView(roomId, member.userId)).rejects.toBeInstanceOf(NotFound);
    expect((await repo.getRoomView(roomId, owner.userId)).members.map((m) => m.userId)).toEqual([owner.userId]);
    const { Item } = await docClient().send(new GetCommand({
      TableName: tableName(), Key: { pk: subscription.pk, sk: subscription.sk }, ConsistentRead: true,
    }));
    expect(Item).toBeUndefined();
  });

  it("a removed member's socket subscriptions go with them", async () => {
    const { owner, member, roomId } = await roomWithMember();
    const subscription = { pk: `ROOM#${roomId}`, sk: `CONN#${randomUUID()}`, userId: member.userId };
    await docClient().send(new PutCommand({ TableName: tableName(), Item: subscription }));
    await repo.removeMember(roomId, owner.userId, member.userId);
    const { Item } = await docClient().send(new GetCommand({
      TableName: tableName(), Key: { pk: subscription.pk, sk: subscription.sk }, ConsistentRead: true,
    }));
    expect(Item).toBeUndefined();
  });

  it("archive: owner only; the room leaves everyone's list and the view says archived", async () => {
    const { owner, member, roomId } = await roomWithMember();
    await expect(repo.archiveRoom(roomId, member.userId)).rejects.toBeInstanceOf(Forbidden);
    await repo.archiveRoom(roomId, owner.userId);
    for (const u of [owner, member]) {
      expect((await repo.listMyRooms(u.userId)).map((r) => r.roomId)).not.toContain(roomId);
      expect((await repo.getRoomView(roomId, u.userId)).room.archived).toBe(true);
    }
  });

  it("an archived room is read-only: its link is revoked, and no chats, links or joins", async () => {
    const owner = user("owner");
    const { roomId } = await repo.createRoom(owner, "Read-only");
    const { code } = await repo.rotateInvite(roomId, owner.userId);
    await repo.archiveRoom(roomId, owner.userId);
    await expect(repo.previewInvite(code)).rejects.toThrow("This invite link was revoked.");
    await expect(repo.acceptInvite(code, user("late"))).rejects.toBeInstanceOf(Gone);
    await expect(repo.createChat(roomId, owner.userId, "more")).rejects.toThrow(new Gone("This room is archived."));
    await expect(repo.rotateInvite(roomId, owner.userId)).rejects.toThrow(new Gone("This room is archived."));
  });

  it("a join on a still-live link can't land in a room archived in the meantime", async () => {
    const owner = user("owner");
    const late = user("late");
    const { roomId } = await repo.createRoom(owner, "Race");
    const { code } = await repo.rotateInvite(roomId, owner.userId);
    // The archive committing between the join's read of the link and its write.
    await docClient().send(new UpdateCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: "META" },
      UpdateExpression: "SET archived = :t", ExpressionAttributeValues: { ":t": true },
    }));
    await expect(repo.acceptInvite(code, late)).rejects.toThrow(new Gone("This room is archived."));
    const { Item } = await docClient().send(new GetCommand({
      TableName: tableName(), Key: { pk: `ROOM#${roomId}`, sk: `MEMBER#${late.userId}` }, ConsistentRead: true,
    }));
    expect(Item).toBeUndefined();
  });

  it("an archive whose member read missed a join is refused, so no member is left unarchived", async () => {
    const owner = user("owner");
    const late = user("late");
    const { roomId } = await repo.createRoom(owner, "Join race");
    const { code } = await repo.rotateInvite(roomId, owner.userId);
    const db = docClient();
    const send = db.send.bind(db);
    // The join committing right after the archive has read the members.
    const spy = vi.spyOn(db, "send").mockImplementation((async (c: QueryCommand) => {
      const out = await send(c as never);
      if (c instanceof QueryCommand && c.input.ExpressionAttributeValues?.[":m"] === "MEMBER#") {
        spy.mockRestore();
        await repo.acceptInvite(code, late);
      }
      return out;
    }) as never);
    await expect(repo.archiveRoom(roomId, owner.userId)).rejects.toBeInstanceOf(Conflict);
    expect((await repo.getRoomView(roomId, late.userId)).room.archived).toBe(false);
    await repo.archiveRoom(roomId, owner.userId);
    expect((await repo.getRoomView(roomId, late.userId)).room.archived).toBe(true);
  });

  it("a room too big for one archive transaction is refused in words, not with a server error", async () => {
    const owner = user("owner");
    const { roomId } = await repo.createRoom(owner, "Crowd");
    await Promise.all(Array.from({ length: 99 }, (_, i) => docClient().send(new PutCommand({
      TableName: tableName(), Item: { pk: `ROOM#${roomId}`, sk: `MEMBER#m${i}`, userId: `m${i}`, role: "member" },
    }))));
    await expect(repo.archiveRoom(roomId, owner.userId)).rejects.toBeInstanceOf(ValidationError);
    expect((await repo.getRoomView(roomId, owner.userId)).room.archived).toBe(false);
  });

  it("the room view reads only the caller's own read state", async () => {
    const { owner, member, roomId } = await roomWithMember();
    const send = vi.spyOn(docClient(), "send");
    try {
      await repo.getRoomView(roomId, member.userId);
      const conditions = send.mock.calls.map(([c]) => c)
        .filter((c) => c instanceof QueryCommand)
        .map((q) => Object.values((q as QueryCommand).input.ExpressionAttributeValues ?? {}).map(String));
      expect(conditions.flat().filter((v) => v.startsWith("READ#"))).toEqual([`READ#${member.userId}#`]);
      expect(conditions.flat()).not.toContain(`READ#${owner.userId}#`);
    } finally {
      send.mockRestore();
    }
  });

  it("muting a chat shows in the view; a chat from another room, or a thread, is NotFound", async () => {
    const { owner, roomId, generalChatId } = await roomWithMember();
    const other = await repo.createRoom(user("o2"), "Other");
    expect(await repo.setChatPrefs(roomId, owner.userId, generalChatId, true)).toEqual({ muted: true });
    expect((await repo.getRoomView(roomId, owner.userId)).chats[0]).toMatchObject({ chatId: generalChatId, muted: true });
    await expect(repo.setChatPrefs(roomId, owner.userId, other.generalChatId, true)).rejects.toBeInstanceOf(NotFound);
    const { thread } = await threadsRepo().createThread(owner, roomId, { text: "notes", clientId: randomUUID() });
    await expect(repo.setChatPrefs(roomId, owner.userId, thread.threadId, true)).rejects.toBeInstanceOf(NotFound);
  });

  it("the view counts unread messages and mentions per chat; the room list totals mentions", async () => {
    const { owner, member, roomId, generalChatId } = await roomWithMember();
    const chat = chatRepo();
    const at = { roomId, chatId: generalChatId };
    await chat.send(owner, { ...at, clientId: "a", text: "hello" });
    await chat.send(owner, { ...at, clientId: "b", text: "hey @member" });
    expect((await repo.getRoomView(roomId, member.userId)).chats[0])
      .toMatchObject({ lastSeq: 2, unread: 2, mentions: 1, muted: false });
    expect((await repo.getRoomView(roomId, owner.userId)).chats[0]).toMatchObject({ unread: 0, mentions: 0 });
    expect((await repo.listMyRooms(member.userId)).find((r) => r.roomId === roomId)).toMatchObject({ mentions: 1 });
  });

  it("members show online from their presence, with when they were last seen", async () => {
    const { owner, member, roomId } = await roomWithMember();
    await markConnected(member.userId);
    const { members } = await repo.getRoomView(roomId, owner.userId);
    expect(members.find((m) => m.userId === member.userId)).toMatchObject({ online: true, lastSeen: expect.any(String) });
    const ownerSeen = members.find((m) => m.userId === owner.userId);
    expect(ownerSeen).toMatchObject({ online: false });
    expect(ownerSeen).not.toHaveProperty("lastSeen");
  });

  it("the directory lists chats (archived flagged), threads and members with roles, for no caller", async () => {
    const { owner, member, roomId } = await roomWithMember();
    const { chatId } = await repo.createChat(roomId, owner.userId, "ops");
    await repo.setChatArchived(roomId, owner.userId, chatId, true);
    const directory = await roomDirectory(roomId);
    expect(directory.room).toEqual({ roomId, name: "Pair" });
    expect(directory.chats.map((c) => [c.name, c.archived])).toEqual([["general", false], ["ops", true]]);
    expect(directory.members).toEqual(expect.arrayContaining([
      { userId: owner.userId, username: "owner", role: "owner" }, { userId: member.userId, username: "member", role: "member" },
    ]));
    expect(directory.threads).toEqual([]);
    expect(directory.agents.map((a) => [a.agentId, a.builtIn])).toEqual([["agent", true]]);
    await expect(roomDirectory(randomUUID())).rejects.toBeInstanceOf(NotFound);
  });
});
