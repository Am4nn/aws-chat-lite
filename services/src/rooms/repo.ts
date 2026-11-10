import { randomUUID } from "node:crypto";
import {
  DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { batchGet, conditionFailed, docClient, tableName } from "../lib/db.js";
import { Conflict, Forbidden, Gone, NotFound, ValidationError } from "../lib/errors.js";
import { isOnline, type Presence } from "../live/presence.js";
import { can, type Action, type Role } from "./access.js";
import { chatName, roomName } from "./model.js";
import { INVITE_TTL_SEC, inviteState, newInviteCode } from "./invites.js";

interface User { userId: string; username: string }
interface RoomView {
  room: { roomId: string; name: string; ownerId: string; archived: boolean };
  me: { role: Role };
  chats: { chatId: string; name: string; lastSeq: number; unread: number; mentions: number; muted: boolean }[];
  members: { userId: string; username: string; role: Role; online: boolean; lastSeen?: string }[];
}

const nowSec = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();
const roomKey = (roomId: string) => `ROOM#${roomId}`;
const memberKey = (roomId: string, userId: string) => ({ pk: roomKey(roomId), sk: `MEMBER#${userId}` });
const roomInviteKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "INVITE" });
const inviteKey = (code: string) => ({ pk: `INVITE#${code}`, sk: "META" });
const counterKey = (chatId: string) => ({ pk: `CHAT#${chatId}`, sk: "META" });
const presenceKey = (userId: string) => ({ pk: `USER#${userId}`, sk: "PRESENCE" });
/** The id at the end of a key such as `CHAT#<id>` or `READ#<userId>#<chatId>` (ids never contain "#"). */
const lastPart = (key: unknown) => String(key).slice(String(key).lastIndexOf("#") + 1);

/**
 * Member item. gsi1 lists a user's rooms in join order; the copied room name saves a read per room in that list.
 * `mentions` totals the member's unread mentions across the room's chats, so the room list needs no per-chat reads.
 */
function memberItem(roomId: string, roomName: string, user: User, role: Role, at: string) {
  return {
    ...memberKey(roomId, user.userId), roomId, roomName, userId: user.userId, username: user.username, role, joinedAt: at,
    mentions: 0, gsi1pk: `USER#${user.userId}`, gsi1sk: `ROOM#${at}#${roomId}`,
  };
}

/** Chats sort by creation time within the room. */
function chatItem(roomId: string, chatId: string, name: string, createdBy: string, at: string) {
  return { pk: roomKey(roomId), sk: `CHAT#${at}#${chatId}`, chatId, name, createdBy, createdAt: at };
}

/**
 * The chat's message counter, in the chat's own partition next to its messages. Each send increments it to get the
 * next seq, and the stored roomId lets that same increment prove the chat belongs to the room the sender is in.
 */
function chatCounterItem(roomId: string, chatId: string) {
  return { ...counterKey(chatId), roomId, lastSeq: 0 };
}

/** One item per chat name in a room, so a conditional put on it can refuse a duplicate name. */
function chatNameItem(roomId: string, name: string, chatId: string) {
  return { pk: roomKey(roomId), sk: `CHATNAME#${name}`, chatId };
}

/** DynamoDB access for rooms, chats, members and invites (single table). Every method checks the caller's role. */
export function roomsRepo() {
  const db = docClient();
  const TableName = tableName();

  /**
   * Role reads are strongly consistent (base-table reads allow it, at twice the read cost) so that someone removed a
   * moment ago is refused at once, and someone who just joined is let in at once.
   */
  async function memberRole(roomId: string, userId: string): Promise<Role | undefined> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: memberKey(roomId, userId), ConsistentRead: true }));
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

  /**
   * Marked revoked rather than deleted, so someone holding the old link is told it was revoked, not that it never
   * existed. If the TTL sweep already deleted the item, the update recreates it, so it gets an expiry of its own.
   */
  const revokeCode = (code: string) => ({
    Update: {
      TableName, Key: inviteKey(code), UpdateExpression: "SET revoked = :t, #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#ttl": "ttl" }, ExpressionAttributeValues: { ":t": true, ":ttl": nowSec() + 86400 },
    },
  });

  /**
   * Optimistic locking on the room's invite pointer: the write only applies if the pointer still holds the code we
   * read. Without it, two rotates at once would each revoke the same old code, and the loser's new code would stay
   * live for a week with nothing pointing at it, so nobody could revoke it.
   */
  const unchangedSince = (read: { code: string } | undefined) => read
    ? { ConditionExpression: "code = :read", ExpressionAttributeValues: { ":read": read.code } }
    : { ConditionExpression: "attribute_not_exists(pk)" };

  async function inviteWrite(TransactItems: TransactWriteCommandInput["TransactItems"]) {
    try {
      await db.send(new TransactWriteCommand({ TransactItems }));
    } catch (e) {
      if (conditionFailed(e)) throw new Conflict("The invite link just changed; try again.");
      throw e;
    }
  }

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
          { Put: { TableName, Item: chatCounterItem(roomId, chatId) } },
        ],
      }));
      return { roomId, name, generalChatId: chatId };
    },

    /** Archived rooms drop out of the list. The member item's mention total feeds the list's dot. */
    async listMyRooms(userId: string) {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :u",
        ExpressionAttributeValues: { ":u": `USER#${userId}` },
      }));
      return Items.filter((i) => !i.archived).map((i) => ({
        roomId: String(i.roomId), name: String(i.roomName), role: i.role as Role, mentions: Number(i.mentions ?? 0),
      }));
    },

    /**
     * One query of the room's partition brings the room, its chats, its members and your read state; it reads
     * consistently, so a room you just created or joined is there on the very next page load. Each chat's message
     * count lives in the chat's own partition and each member's presence in theirs, so those come from two BatchGets.
     */
    async getRoomView(roomId: string, userId: string): Promise<RoomView> {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": roomKey(roomId) }, ConsistentRead: true,
      }));
      const me = Items.find((i) => i.sk === `MEMBER#${userId}`);
      const meta = Items.find((i) => i.sk === "META");
      if (!me || !meta) throw new NotFound("Room not found.");
      const startingWith = (prefix: string) => Items.filter((i) => String(i.sk).startsWith(prefix));
      const chats = startingWith("CHAT#");
      const members = startingWith("MEMBER#");
      const reads = new Map(startingWith(`READ#${userId}#`).map((r) => [lastPart(r.sk), r]));
      const [counters, presences] = await Promise.all([
        batchGet(chats.map((c) => counterKey(String(c.chatId))), { consistent: true }),
        batchGet(members.map((m) => presenceKey(String(m.userId)))),
      ]);
      const lastSeqOf = new Map(counters.map((c) => [lastPart(c.pk), Number(c.lastSeq)]));
      const presenceOf = new Map(presences.map((p) => [lastPart(p.pk), p as unknown as Presence]));
      const now = Math.floor(Date.now() / 1000);
      return {
        room: { roomId, name: String(meta.name), ownerId: String(meta.ownerId), archived: !!meta.archived },
        me: { role: me.role as Role },
        chats: chats.map((c) => {
          const chatId = String(c.chatId);
          const read = reads.get(chatId);
          const lastSeq = lastSeqOf.get(chatId) ?? 0;
          return {
            chatId, name: String(c.name), lastSeq, unread: Math.max(0, lastSeq - Number(read?.lastReadSeq ?? 0)),
            mentions: Number(read?.mentions ?? 0), muted: !!read?.muted,
          };
        }),
        members: members.map((m) => {
          const presence = presenceOf.get(String(m.userId));
          return {
            userId: String(m.userId), username: String(m.username), role: m.role as Role,
            online: isOnline(presence, now), ...(presence && { lastSeen: presence.lastSeen }),
          };
        }),
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
            { Put: { TableName, Item: chatCounterItem(roomId, chatId) } },
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
      try {
        // The condition stops the update from recreating someone who was removed after our read.
        await db.send(new UpdateCommand({
          TableName, Key: memberKey(roomId, targetId),
          UpdateExpression: "SET #r = :r", ConditionExpression: "attribute_exists(pk) AND #r <> :owner",
          ExpressionAttributeNames: { "#r": "role" }, ExpressionAttributeValues: { ":r": role, ":owner": "owner" },
        }));
      } catch (e) {
        if (conditionFailed(e)) throw new NotFound("Not a member of this room.");
        throw e;
      }
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

    /** Mute is per member and per chat, so it lives on the member's read state for that chat. */
    async setChatPrefs(roomId: string, userId: string, chatId: string, muted: unknown) {
      if (typeof muted !== "boolean") throw new ValidationError("muted must be true or false.");
      await requireRole(roomId, userId, "read");
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            // The chat's counter proves the chat is in this room, so no read state is written for another room's chat.
            { ConditionCheck: { TableName, Key: counterKey(chatId), ConditionExpression: "roomId = :r", ExpressionAttributeValues: { ":r": roomId } } },
            {
              Update: {
                TableName, Key: { pk: roomKey(roomId), sk: `READ#${userId}#${chatId}` },
                UpdateExpression: "SET muted = :m", ExpressionAttributeValues: { ":m": muted },
              },
            },
          ],
        }));
      } catch (e) {
        if (conditionFailed(e)) throw new NotFound("Chat not found.");
        throw e;
      }
      return { muted };
    },

    /**
     * Your membership goes, and so do your sockets' subscriptions to the room. Live events already skip anyone who
     * isn't a member; deleting the subscriptions saves the room's fan-out from reading them.
     */
    async leaveRoom(roomId: string, userId: string) {
      const role = await memberRole(roomId, userId);
      if (!role) throw new NotFound("Room not found.");
      if (!can("leave", role)) throw new Forbidden("The owner can't leave their own room.");
      await db.send(new DeleteCommand({ TableName, Key: memberKey(roomId, userId) }));
      const { Items: subscriptions = [] } = await db.send(new QueryCommand({
        TableName, KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", FilterExpression: "userId = :u",
        ExpressionAttributeValues: { ":p": roomKey(roomId), ":c": "CONN#", ":u": userId },
      }));
      await Promise.all(subscriptions.map((s) => db.send(new DeleteCommand({ TableName, Key: { pk: s.pk, sk: s.sk } }))));
      return {};
    },

    /**
     * Marks the room and every member item archived in one transaction, so the room is never half archived, with some
     * members refused new messages while others still post. The member items carry the flag because every chat write
     * already reads the member item, and the room list reads them through gsi1. A transaction holds at most 100
     * items, which caps this at rooms of 99 members.
     */
    async archiveRoom(roomId: string, userId: string) {
      await requireRole(roomId, userId, "archive");
      const { Items: members = [] } = await db.send(new QueryCommand({
        TableName, KeyConditionExpression: "pk = :p AND begins_with(sk, :m)", ProjectionExpression: "sk", ConsistentRead: true,
        ExpressionAttributeValues: { ":p": roomKey(roomId), ":m": "MEMBER#" },
      }));
      const archive = (sk: string) => ({
        Update: {
          TableName, Key: { pk: roomKey(roomId), sk }, UpdateExpression: "SET archived = :t",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":t": true },
        },
      });
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [archive("META"), ...members.map((m) => archive(String(m.sk)))] }));
      } catch (e) {
        if (conditionFailed(e)) throw new Conflict("The members just changed; try again.");
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
      await inviteWrite([
        { Put: { TableName, Item: { ...roomInviteKey(roomId), code, expiresAt, createdBy: userId }, ...unchangedSince(old) } },
        { Put: { TableName, Item: { ...inviteKey(code), roomId, roomName: meta.name, expiresAt, ttl: expiresAt + 86400 } } },
        ...(old ? [revokeCode(old.code)] : []),
      ]);
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
      await inviteWrite([{ Delete: { TableName, Key: roomInviteKey(roomId), ...unchangedSince(invite) } }, revokeCode(invite.code)]);
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
