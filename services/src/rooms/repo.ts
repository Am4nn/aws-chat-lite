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

const now = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();
const ROOM = (id: string) => `ROOM#${id}`;

/** True when a write failed its condition (single write or one item of a transaction). */
function conditionFailed(e: unknown): boolean {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  return err.name === "ConditionalCheckFailedException"
    || (err.name === "TransactionCanceledException" && !!err.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed"));
}

/** DynamoDB access for rooms, chats, members and invites (single table). Every method checks the caller's role. */
export function roomsRepo() {
  const db = docClient();
  const T = tableName;

  async function memberRole(roomId: string, userId: string): Promise<Role | undefined> {
    const { Item } = await db.send(new GetCommand({ TableName: T(), Key: { pk: ROOM(roomId), sk: `MEMBER#${userId}` } }));
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
    const { Item } = await db.send(new GetCommand({ TableName: T(), Key: { pk: ROOM(roomId), sk: "META" } }));
    if (!Item) throw new NotFound("Room not found.");
    return Item as { name: string; ownerId: string };
  }

  return {
    /** Room + owner membership + #general, all or nothing. */
    async createRoom(owner: User, rawName: unknown) {
      const name = roomName(rawName);
      const roomId = randomUUID();
      const chatId = randomUUID();
      const at = iso();
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: T(), Item: { pk: ROOM(roomId), sk: "META", name, ownerId: owner.userId, createdAt: at }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: T(), Item: memberItem(roomId, name, owner, "owner", at) } },
          { Put: { TableName: T(), Item: { pk: ROOM(roomId), sk: `CHAT#${at}#${chatId}`, chatId, name: "general", createdBy: owner.userId, createdAt: at } } },
          { Put: { TableName: T(), Item: { pk: ROOM(roomId), sk: "CHATNAME#general", chatId } } },
        ],
      }));
      return { roomId, name, generalChatId: chatId };
    },

    async listMyRooms(userId: string) {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName: T(), IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :u",
        ExpressionAttributeValues: { ":u": `USER#${userId}` },
      }));
      return Items.map((i) => ({ roomId: String(i.roomId), name: String(i.roomName), role: i.role as Role }));
    },

    async getRoomView(roomId: string, userId: string): Promise<RoomView> {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName: T(), KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": ROOM(roomId) },
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
      const at = iso();
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: T(), Item: { pk: ROOM(roomId), sk: `CHATNAME#${name}`, chatId }, ConditionExpression: "attribute_not_exists(pk)" } },
            { Put: { TableName: T(), Item: { pk: ROOM(roomId), sk: `CHAT#${at}#${chatId}`, chatId, name, createdBy: userId, createdAt: at } } },
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
      await requireRole(roomId, actorId, "setRole", target ?? "member");
      if (!target) throw new NotFound("Not a member of this room.");
      await db.send(new UpdateCommand({
        TableName: T(), Key: { pk: ROOM(roomId), sk: `MEMBER#${targetId}` },
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
          TableName: T(), Key: { pk: ROOM(roomId), sk: `MEMBER#${targetId}` },
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
      const old = await db.send(new GetCommand({ TableName: T(), Key: { pk: ROOM(roomId), sk: "INVITE" } }));
      const code = newInviteCode();
      const expiresAt = now() + INVITE_TTL_SEC;
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: T(), Item: { pk: ROOM(roomId), sk: "INVITE", code, expiresAt, createdBy: userId } } },
          { Put: { TableName: T(), Item: { pk: `INVITE#${code}`, sk: "META", roomId, roomName: meta.name, expiresAt, ttl: expiresAt + 86400 } } },
          ...(old.Item ? [{ Update: {
            TableName: T(), Key: { pk: `INVITE#${old.Item.code}`, sk: "META" }, UpdateExpression: "SET revoked = :t",
            ExpressionAttributeValues: { ":t": true },
          } }] : []),
        ],
      }));
      return { code, expiresAt };
    },

    async getInvite(roomId: string, userId: string) {
      await requireRole(roomId, userId, "manageInvite");
      const { Item } = await db.send(new GetCommand({ TableName: T(), Key: { pk: ROOM(roomId), sk: "INVITE" } }));
      if (!Item || inviteState(Item as { expiresAt: number }, now()) !== "ok") throw new NotFound("No active invite link.");
      return { code: String(Item.code), expiresAt: Number(Item.expiresAt) };
    },

    async revokeInvite(roomId: string, userId: string) {
      await requireRole(roomId, userId, "manageInvite");
      const { Item } = await db.send(new GetCommand({ TableName: T(), Key: { pk: ROOM(roomId), sk: "INVITE" } }));
      if (!Item) return {};
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: T(), Key: { pk: ROOM(roomId), sk: "INVITE" } } },
          { Update: { TableName: T(), Key: { pk: `INVITE#${Item.code}`, sk: "META" }, UpdateExpression: "SET revoked = :t", ExpressionAttributeValues: { ":t": true } } },
        ],
      }));
      return {};
    },

    /** Public: what a link leads to, before you sign in. */
    async previewInvite(code: string) {
      const inv = await liveInvite(code);
      const { Count = 0 } = await db.send(new QueryCommand({
        TableName: T(), KeyConditionExpression: "pk = :p AND begins_with(sk, :m)",
        ExpressionAttributeValues: { ":p": ROOM(inv.roomId), ":m": "MEMBER#" }, Select: "COUNT",
      }));
      return { roomName: inv.roomName, memberCount: Count, expiresAt: inv.expiresAt };
    },

    /** Join as member. Already in the room: nothing changes (an admin stays admin). */
    async acceptInvite(code: string, user: User) {
      const inv = await liveInvite(code);
      try {
        await db.send(new PutCommand({
          TableName: T(), Item: memberItem(inv.roomId, inv.roomName, user, "member", iso()),
          ConditionExpression: "attribute_not_exists(pk)",
        }));
      } catch (e) {
        if (!conditionFailed(e)) throw e; // already a member (or a concurrent accept won): fine
      }
      return { roomId: inv.roomId };
    },
  };

  async function liveInvite(code: string) {
    const { Item } = await db.send(new GetCommand({ TableName: T(), Key: { pk: `INVITE#${code}`, sk: "META" } }));
    const state = inviteState(Item as { expiresAt: number; revoked?: boolean } | undefined, now());
    if (state === "missing") throw new NotFound("This invite link doesn't exist.");
    if (state !== "ok") throw new Gone(state === "revoked" ? "This invite link was revoked." : "This invite link expired.");
    return Item as { roomId: string; roomName: string; expiresAt: number };
  }
}

/** Member item; gsi1 lists a user's rooms (newest join last). Keeps the room name for the room list. */
function memberItem(roomId: string, roomName: string, user: User, role: Role, at: string) {
  return {
    pk: ROOM(roomId), sk: `MEMBER#${user.userId}`, roomId, roomName, userId: user.userId, username: user.username, role, joinedAt: at,
    gsi1pk: `USER#${user.userId}`, gsi1sk: `ROOM#${at}#${roomId}`,
  };
}

export type RoomsRepo = ReturnType<typeof roomsRepo>;
