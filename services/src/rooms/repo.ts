import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { can, type Action, type Role } from "./access.js";
import { chatName, roomName, Conflict, Forbidden, Gone, NotFound, ValidationError } from "./model.js";
import { INVITE_TTL_SEC, inviteState, newInviteCode } from "./invites.js";

interface User { userId: string; username: string }
interface RoomView {
  room: { roomId: string; name: string; ownerId: string };
  me: { role: Role };
  chats: { chatId: string; name: string }[];
  members: { userId: string; username: string; role: Role }[];
}

const nowSec = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();
const roomKey = (roomId: string) => `ROOM#${roomId}`;
const memberKey = (roomId: string, userId: string) => ({ pk: roomKey(roomId), sk: `MEMBER#${userId}` });
const roomInviteKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "INVITE" });
const inviteKey = (code: string) => ({ pk: `INVITE#${code}`, sk: "META" });

/** True when a write failed its condition (single write or one item of a transaction). */
function conditionFailed(e: unknown): boolean {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  return err.name === "ConditionalCheckFailedException"
    || (err.name === "TransactionCanceledException" && !!err.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed"));
}

/** Member item. gsi1 lists a user's rooms in join order; the copied room name saves a read per room in that list. */
function memberItem(roomId: string, roomName: string, user: User, role: Role, at: string) {
  return {
    ...memberKey(roomId, user.userId), roomId, roomName, userId: user.userId, username: user.username, role, joinedAt: at,
    gsi1pk: `USER#${user.userId}`, gsi1sk: `ROOM#${at}#${roomId}`,
  };
}

/** Chats sort by creation time within the room. */
function chatItem(roomId: string, chatId: string, name: string, createdBy: string, at: string) {
  return { pk: roomKey(roomId), sk: `CHAT#${at}#${chatId}`, chatId, name, createdBy, createdAt: at };
}

/** One item per chat name in a room, so a conditional put on it can refuse a duplicate name. */
function chatNameItem(roomId: string, name: string, chatId: string) {
  return { pk: roomKey(roomId), sk: `CHATNAME#${name}`, chatId };
}

/** DynamoDB access for rooms, chats, members and invites (single table). Every method checks the caller's role. */
export function roomsRepo() {
  const db = docClient();
  const TableName = tableName();

  async function memberRole(roomId: string, userId: string): Promise<Role | undefined> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: memberKey(roomId, userId) }));
    return Item?.role as Role | undefined;
  }

  /** The caller's role, or NotFound when they aren't in the room; Forbidden when the role can't do `action`. */
  async function requireRole(roomId: string, userId: string, action: Action, target?: Role): Promise<Role> {
    const role = await memberRole(roomId, userId);
    if (!role) throw new NotFound("Room not found.");
    if (!can(action, role, target)) throw new Forbidden("Your role in this room can't do that.");
    return role;
  }

  async function roomMeta(roomId: string) {
    const { Item } = await db.send(new GetCommand({ TableName, Key: { pk: roomKey(roomId), sk: "META" } }));
    if (!Item) throw new NotFound("Room not found.");
    return Item as { name: string; ownerId: string };
  }

  async function currentInvite(roomId: string) {
    const { Item } = await db.send(new GetCommand({ TableName, Key: roomInviteKey(roomId) }));
    return Item as { code: string; expiresAt: number } | undefined;
  }

  /** Marked revoked rather than deleted, so someone holding the old link is told it was revoked, not that it never existed. */
  const revokeCode = (code: string) => ({
    Update: { TableName, Key: inviteKey(code), UpdateExpression: "SET revoked = :t", ExpressionAttributeValues: { ":t": true } },
  });

  async function liveInvite(code: string) {
    const { Item } = await db.send(new GetCommand({ TableName, Key: inviteKey(code) }));
    const state = inviteState(Item as { expiresAt: number; revoked?: boolean } | undefined, nowSec());
    if (state === "missing") throw new NotFound("This invite link doesn't exist.");
    if (state !== "ok") throw new Gone(state === "revoked" ? "This invite link was revoked." : "This invite link expired.");
    return Item as { roomId: string; roomName: string; expiresAt: number };
  }

  return {
    /** Room + owner membership + #general, all or nothing. */
    async createRoom(owner: User, rawName: unknown) {
      const name = roomName(rawName);
      const roomId = randomUUID();
      const chatId = randomUUID();
      const at = nowIso();
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName, Item: { pk: roomKey(roomId), sk: "META", name, ownerId: owner.userId, createdAt: at }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName, Item: memberItem(roomId, name, owner, "owner", at) } },
          { Put: { TableName, Item: chatItem(roomId, chatId, "general", owner.userId, at) } },
          { Put: { TableName, Item: chatNameItem(roomId, "general", chatId) } },
        ],
      }));
      return { roomId, name, generalChatId: chatId };
    },

    async listMyRooms(userId: string) {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :u",
        ExpressionAttributeValues: { ":u": `USER#${userId}` },
      }));
      return Items.map((i) => ({ roomId: String(i.roomId), name: String(i.roomName), role: i.role as Role }));
    },

    async getRoomView(roomId: string, userId: string): Promise<RoomView> {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": roomKey(roomId) },
      }));
      const me = Items.find((i) => i.sk === `MEMBER#${userId}`);
      const meta = Items.find((i) => i.sk === "META");
      if (!me || !meta) throw new NotFound("Room not found.");
      return {
        room: { roomId, name: String(meta.name), ownerId: String(meta.ownerId) },
        me: { role: me.role as Role },
        chats: Items.filter((i) => String(i.sk).startsWith("CHAT#")).map((i) => ({ chatId: String(i.chatId), name: String(i.name) })),
        members: Items.filter((i) => String(i.sk).startsWith("MEMBER#"))
          .map((i) => ({ userId: String(i.userId), username: String(i.username), role: i.role as Role })),
      };
    },

    /** The name guard item makes duplicate names impossible, even for two requests at the same moment. */
    async createChat(roomId: string, userId: string, rawName: unknown) {
      const name = chatName(rawName);
      await requireRole(roomId, userId, "createChat");
      const chatId = randomUUID();
      const at = nowIso();
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName, Item: chatNameItem(roomId, name, chatId), ConditionExpression: "attribute_not_exists(pk)" } },
            { Put: { TableName, Item: chatItem(roomId, chatId, name, userId, at) } },
          ],
        }));
      } catch (e) {
        if (conditionFailed(e)) throw new Conflict(`#${name} already exists.`);
        throw e;
      }
      return { chatId, name };
    },

    async setRole(roomId: string, actorId: string, targetId: string, role: unknown) {
      if (role !== "admin" && role !== "member") throw new ValidationError("Role must be admin or member.");
      const target = await memberRole(roomId, targetId);
      // The caller's own access is checked before revealing whether the target is in the room.
      await requireRole(roomId, actorId, "setRole", target ?? "member");
      if (!target) throw new NotFound("Not a member of this room.");
      await db.send(new UpdateCommand({
        TableName, Key: memberKey(roomId, targetId),
        UpdateExpression: "SET #r = :r", ConditionExpression: "attribute_exists(pk) AND #r <> :owner",
        ExpressionAttributeNames: { "#r": "role" }, ExpressionAttributeValues: { ":r": role, ":owner": "owner" },
      }));
      return { userId: targetId, role };
    },

    async removeMember(roomId: string, actorId: string, targetId: string) {
      const target = await memberRole(roomId, targetId);
      await requireRole(roomId, actorId, "removeMember", target ?? "member");
      if (!target) throw new NotFound("Not a member of this room.");
      try {
        // The condition stops a race where the target was promoted between our read and this delete.
        await db.send(new DeleteCommand({
          TableName, Key: memberKey(roomId, targetId),
          ConditionExpression: "#r = :r", ExpressionAttributeNames: { "#r": "role" }, ExpressionAttributeValues: { ":r": target },
        }));
      } catch (e) {
        if (conditionFailed(e)) throw new Conflict("Their role just changed; try again.");
        throw e;
      }
      return {};
    },

    /** One live link per room: a new one replaces (and kills) the old one. */
    async rotateInvite(roomId: string, userId: string) {
      await requireRole(roomId, userId, "manageInvite");
      const meta = await roomMeta(roomId);
      const old = await currentInvite(roomId);
      const code = newInviteCode();
      const expiresAt = nowSec() + INVITE_TTL_SEC;
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName, Item: { ...roomInviteKey(roomId), code, expiresAt, createdBy: userId } } },
          { Put: { TableName, Item: { ...inviteKey(code), roomId, roomName: meta.name, expiresAt, ttl: expiresAt + 86400 } } },
          ...(old ? [revokeCode(old.code)] : []),
        ],
      }));
      return { code, expiresAt };
    },

    async getInvite(roomId: string, userId: string) {
      await requireRole(roomId, userId, "manageInvite");
      const invite = await currentInvite(roomId);
      if (!invite || inviteState(invite, nowSec()) !== "ok") throw new NotFound("No active invite link.");
      return { code: String(invite.code), expiresAt: Number(invite.expiresAt) };
    },

    async revokeInvite(roomId: string, userId: string) {
      await requireRole(roomId, userId, "manageInvite");
      const invite = await currentInvite(roomId);
      if (!invite) return {};
      await db.send(new TransactWriteCommand({
        TransactItems: [{ Delete: { TableName, Key: roomInviteKey(roomId) } }, revokeCode(invite.code)],
      }));
      return {};
    },

    /** Public: what a link leads to, before you sign in. */
    async previewInvite(code: string) {
      const inv = await liveInvite(code);
      const { Count = 0 } = await db.send(new QueryCommand({
        TableName, KeyConditionExpression: "pk = :p AND begins_with(sk, :m)",
        ExpressionAttributeValues: { ":p": roomKey(inv.roomId), ":m": "MEMBER#" }, Select: "COUNT",
      }));
      return { roomName: inv.roomName, memberCount: Count, expiresAt: inv.expiresAt };
    },

    /** Join as member. Already in the room: nothing changes (an admin stays admin). */
    async acceptInvite(code: string, user: User) {
      const inv = await liveInvite(code);
      try {
        await db.send(new PutCommand({
          TableName, Item: memberItem(inv.roomId, inv.roomName, user, "member", nowIso()),
          ConditionExpression: "attribute_not_exists(pk)",
        }));
      } catch (e) {
        if (!conditionFailed(e)) throw e; // Already a member, or a concurrent accept won: either way they are in.
      }
      return { roomId: inv.roomId };
    },
  };
}

export type RoomsRepo = ReturnType<typeof roomsRepo>;
