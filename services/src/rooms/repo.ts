import { randomUUID } from "node:crypto";
import {
  DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { batchGet, conditionFailed, docClient, failedAt, queryAll, tableName, transactionConflict } from "../lib/db.js";
import { Conflict, Forbidden, Gone, NotFound, ValidationError } from "../lib/errors.js";
import { counterKey, memberKey, roomKey } from "../lib/keys.js";
import { findMember, liveMemberships, requireMember, roomMembers } from "../chat/membership.js";
import { isOnline, type Presence } from "../live/presence.js";
import { budgetOf, monthKey } from "../budget/model.js";
import { modelOptions, type ModelOption, type ModelPick } from "../models/catalog.js";
import { agentsRepo } from "../agents/repo.js";
import { DEFAULT_TIME_ZONE } from "../schedules/zone.js";
import { claimableName, summary } from "../threads/model.js";
import type { Agent, Budget, ThreadSummary } from "../threads/types.js";
import { can, type Action, type Role } from "./access.js";
import { chatName, roomName } from "./model.js";
import { INVITE_TTL_SEC, inviteState, newInviteCode } from "./invites.js";

interface RoomView {
  room: { roomId: string; name: string; ownerId: string; archived: boolean };
  me: { role: Role };
  chats: { chatId: string; name: string; lastSeq: number; unread: number; mentions: number; muted: boolean }[];
  members: { userId: string; username: string; role: Role; online: boolean; lastSeen?: string }[];
  threads: ThreadSummary[];
  budget: Budget;
  defaultModel: ModelPick;
  /** The model picker, as this stage offers it. */
  models: ModelOption[];
  /** Whether the room's sandbox reaches the internet; off until an admin turns it on. */
  sandboxInternet: boolean;
  /** The built-in @agent first, then the others by name. */
  agents: Agent[];
  /** The IANA zone the room's schedules fire in. */
  timeZone: string;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();
const roomInviteKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "INVITE" });
const inviteKey = (code: string) => ({ pk: `INVITE#${code}`, sk: "META" });
const presenceKey = (userId: string) => ({ pk: `USER#${userId}`, sk: "PRESENCE" });
/** The id at the end of a key such as `CHAT#<id>` or `READ#<userId>#<chatId>` (ids never contain "#"). */
const lastPart = (key: unknown) => String(key).slice(String(key).lastIndexOf("#") + 1);

/** A transaction holds at most 100 items; archiving also writes META and, for the invite link, two more. */
const MAX_ARCHIVE_MEMBERS = 97;

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

  /** The caller's role, as `requireMember` reads it; Forbidden when it can't do `action` (on a member with role `target`). */
  async function requireRole(roomId: string, userId: string, action: Action, opts: { target?: Role; writing?: boolean } = {}) {
    const role = await requireMember(roomId, userId, opts);
    if (!can(action, role, opts.target)) throw new Forbidden("Your role in this room can't do that.");
    return role;
  }

  /**
   * Someone who left or was removed loses their sockets' subscriptions to the room. Live events already skip anyone
   * who isn't a member; deleting the subscriptions saves the room's fan-out from reading them.
   */
  async function dropSubscriptions(roomId: string, userId: string) {
    const subscriptions = await queryAll({
      KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", FilterExpression: "userId = :u",
      ExpressionAttributeValues: { ":p": roomKey(roomId), ":c": "CONN#", ":u": userId },
    });
    await Promise.all(subscriptions.map((s) => db.send(new DeleteCommand({ TableName, Key: { pk: s.pk, sk: s.sk } }))));
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
      return (await liveMemberships(userId)).map((i) => ({
        roomId: String(i.roomId), name: String(i.roomName), role: i.role as Role, mentions: Number(i.mentions ?? 0),
      }));
    },

    /**
     * The room, its chats, threads, members and agents, this month's agent usage and only your own read state, each by
     * sort-key prefix within the room's partition (which also holds every member's read state, every socket's
     * subscription and past months' usage). The reads are consistent, so a room you just created or joined is there on
     * the very next page load. Each chat's message count lives in the chat's own partition and each member's presence
     * in theirs, so those come from two BatchGets.
     */
    async getRoomView(roomId: string, userId: string): Promise<RoomView> {
      const inRoom = (prefix: string) => queryAll({
        KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ConsistentRead: true,
        ExpressionAttributeValues: { ":p": roomKey(roomId), ":s": prefix },
      });
      const month = monthKey(new Date());
      const [{ Item: meta }, chats, threads, members, myReads, [usage], agents] = await Promise.all([
        db.send(new GetCommand({ TableName, Key: { pk: roomKey(roomId), sk: "META" }, ConsistentRead: true })),
        inRoom("CHAT#"), inRoom("THREAD#"), roomMembers(roomId, { consistent: true }), inRoom(`READ#${userId}#`), inRoom(`USAGE#${month}`),
        agentsRepo().list(roomId),
      ]);
      const me = members.find((m) => m.userId === userId);
      if (!me || !meta) throw new NotFound("Room not found.");
      const reads = new Map(myReads.map((r) => [lastPart(r.sk), r]));
      const [counters, presences] = await Promise.all([
        batchGet(chats.map((c) => counterKey(String(c.chatId))), { consistent: true }),
        batchGet(members.map((m) => presenceKey(String(m.userId)))),
      ]);
      const lastSeqOf = new Map(counters.map((c) => [lastPart(c.pk), Number(c.lastSeq)]));
      const presenceOf = new Map(presences.map((p) => [lastPart(p.pk), p as unknown as Presence]));
      const nowMs = Date.now();
      const now = Math.floor(nowMs / 1000);
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
        threads: threads.map((t) => summary(t, nowMs)),
        budget: budgetOf(month, meta, usage),
        defaultModel: (meta.defaultModel as ModelPick | undefined) ?? "auto",
        models: modelOptions(process.env.STAGE ?? ""),
        sandboxInternet: !!meta.sandboxInternet,
        agents,
        timeZone: (meta.timeZone as string | undefined) ?? DEFAULT_TIME_ZONE,
      };
    },

    /** The model a run uses when its message picks none. `pick` is already validated. */
    async setDefaultModel(user: User, roomId: string, pick: ModelPick): Promise<ModelPick> {
      await requireRole(roomId, user.userId, "setModel", { writing: true });
      await db.send(new UpdateCommand({
        TableName, Key: { pk: roomKey(roomId), sk: "META" }, UpdateExpression: "SET #defaultModel = :m",
        ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#defaultModel": "defaultModel" },
        ExpressionAttributeValues: { ":m": pick },
      }));
      return pick;
    },

    /** Read when a run opens its sandbox, so a change applies to the next sandbox, not to one already open. */
    async setSandboxInternet(user: User, roomId: string, on: boolean): Promise<boolean> {
      await requireRole(roomId, user.userId, "setSandbox", { writing: true });
      await db.send(new UpdateCommand({
        TableName, Key: { pk: roomKey(roomId), sk: "META" }, UpdateExpression: "SET sandboxInternet = :on",
        ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":on": on },
      }));
      return on;
    },

    /**
     * The name guard item makes duplicate names impossible, even for two requests at the same moment. Threads use the
     * same guards, so a chat can't take a thread's name either.
     */
    async createChat(roomId: string, userId: string, rawName: unknown) {
      const name = claimableName(chatName(rawName));
      await requireRole(roomId, userId, "createChat", { writing: true });
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
      const target = (await findMember(roomId, targetId))?.role;
      // The caller's own access is checked before revealing whether the target is in the room.
      await requireRole(roomId, actorId, "setRole", { target: target ?? "member" });
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
      const target = (await findMember(roomId, targetId))?.role;
      await requireRole(roomId, actorId, "removeMember", { target: target ?? "member" });
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
      await dropSubscriptions(roomId, targetId);
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

    async leaveRoom(roomId: string, userId: string) {
      if (!can("leave", await requireMember(roomId, userId))) throw new Forbidden("The owner can't leave their own room.");
      await db.send(new DeleteCommand({ TableName, Key: memberKey(roomId, userId) }));
      await dropSubscriptions(roomId, userId);
      return {};
    },

    /**
     * Marks the room and every member item archived and revokes the invite link, in one transaction, so the room is
     * never half archived (some members refused new messages while others still post, or a live link into a closed
     * room). The member items carry the flag because every chat write already reads the member item, and the room list
     * reads them through gsi1. Every join counts itself on META, read here before the members, so a join landing after
     * that read fails the META condition instead of leaving one member unarchived.
     */
    async archiveRoom(roomId: string, userId: string) {
      await requireRole(roomId, userId, "archive");
      const { Item: meta } = await db.send(new GetCommand({ TableName, Key: { pk: roomKey(roomId), sk: "META" }, ConsistentRead: true }));
      const members = await roomMembers(roomId, { fields: ["sk"], consistent: true });
      if (members.length > MAX_ARCHIVE_MEMBERS) {
        throw new ValidationError(`Rooms over ${MAX_ARCHIVE_MEMBERS} members can't be archived yet.`);
      }
      const invite = await currentInvite(roomId);
      const archive = (sk: string, alsoIf = "", values = {}) => ({
        Update: {
          TableName, Key: { pk: roomKey(roomId), sk }, UpdateExpression: "SET archived = :t",
          ConditionExpression: `attribute_exists(pk)${alsoIf}`, ExpressionAttributeValues: { ":t": true, ...values },
        },
      });
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            // `joinCount` is never removed once set, so a room nobody has joined yet matches on its absence.
            archive("META", " AND (attribute_not_exists(joinCount) OR joinCount = :joins)", { ":joins": Number(meta?.joinCount ?? 0) }),
            ...members.map((m) => archive(String(m.sk))),
            ...(invite ? [{ Delete: { TableName, Key: roomInviteKey(roomId), ...unchangedSince(invite) } }, revokeCode(invite.code)] : []),
          ],
        }));
      } catch (e) {
        if (conditionFailed(e) || transactionConflict(e)) throw new Conflict("The room just changed; try again.");
        throw e;
      }
      return {};
    },

    /** One live link per room: a new one replaces (and kills) the old one. */
    async rotateInvite(roomId: string, userId: string) {
      await requireRole(roomId, userId, "manageInvite", { writing: true });
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
      const members = await roomMembers(inv.roomId, { fields: ["sk"] });
      return { roomName: inv.roomName, memberCount: members.length, expiresAt: inv.expiresAt };
    },

    /**
     * Join as member. Already in the room: nothing changes (an admin stays admin). The META update in the same
     * transaction refuses an archived room, even one archived after the link was read, and counts the join, so an
     * archive that read the members before this join refuses to apply (see archiveRoom).
     */
    async acceptInvite(code: string, user: User) {
      const inv = await liveInvite(code);
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName, Key: { pk: roomKey(inv.roomId), sk: "META" }, UpdateExpression: "ADD joinCount :one",
                ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(archived)", ExpressionAttributeValues: { ":one": 1 },
              },
            },
            {
              Put: {
                TableName, Item: memberItem(inv.roomId, inv.roomName, user, "member", nowIso()),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }));
      } catch (e) {
        if (failedAt(e, 0)) throw new Gone("This room is archived.");
        if (transactionConflict(e)) throw new Conflict("The room just changed; try again.");
        if (!failedAt(e, 1)) throw e; // Already a member, or a concurrent accept won: either way they are in.
      }
      return { roomId: inv.roomId };
    },
  };
}

export type RoomsRepo = ReturnType<typeof roomsRepo>;
