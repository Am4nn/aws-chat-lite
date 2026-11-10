import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { conditionFailed, docClient, tableName } from "../lib/db.js";
import type { Role } from "../rooms/access.js";
import { Conflict, Forbidden, Gone, NotFound, ValidationError } from "../rooms/model.js";
import { parseMentions } from "./mentions.js";
import {
  EDIT_WINDOW_SEC, LAST_SEQ, MAX_ATTACHMENTS, PAGE, RATE_PER_MIN, canEdit, deleteMode, excerpt, forReaders, messageText,
  seqKey, validAttachment, versionKey, type Attachment, type Message, type Reaction, type StoredMessage,
} from "./model.js";

interface User { userId: string; username: string }
/** Where a message lives: every chat belongs to exactly one room. */
interface ChatRef { roomId: string; chatId: string }
interface Cursor { before?: number; after?: number; around?: number }

const roomKey = (roomId: string) => `ROOM#${roomId}`;
const chatKey = (chatId: string) => `CHAT#${chatId}`;
const memberKey = (roomId: string, userId: string) => ({ pk: roomKey(roomId), sk: `MEMBER#${userId}` });
const readKey = (at: ChatRef, userId: string) => ({ pk: roomKey(at.roomId), sk: `READ#${userId}#${at.chatId}` });
const counterKey = (chatId: string) => ({ pk: chatKey(chatId), sk: "META" });
const messageKey = (at: ChatRef, seq: number) => ({ pk: chatKey(at.chatId), sk: seqKey(seq) });

const NEEDS_CONTENT = "A message needs text or an attachment.";

/** Reactions are stored as string sets (DynamoDB drops a set once it's empty); the wire format wants arrays. */
function toMessage({ pk: _pk, sk: _sk, reactions, ...rest }: Record<string, unknown>): Message {
  const sets = (reactions ?? {}) as Record<string, Set<string>>;
  const lists = Object.fromEntries(Object.entries(sets).map(([k, users]) => [k, [...users]]));
  return forReaders({ ...rest, reactions: lists } as StoredMessage);
}

function attachmentList(raw: unknown, roomId: string, userId: string): Attachment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw new ValidationError(`At most ${MAX_ATTACHMENTS} attachments.`);
  return raw.map((a) => validAttachment(a, roomId, userId));
}

/** Messages, reactions and read state (single table). Every method checks the caller is in the room. */
export function chatRepo() {
  const db = docClient();
  const TableName = tableName();

  /**
   * Read strongly consistently, so someone removed a moment ago is refused at once. An archived room stays readable
   * but takes no new writes.
   */
  async function member(roomId: string, userId: string, opts: { writing?: boolean } = {}): Promise<Role> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: memberKey(roomId, userId), ConsistentRead: true }));
    if (!Item) throw new NotFound("Room not found.");
    if (opts.writing && Item.archived) throw new Gone("This room is archived.");
    return Item.role as Role;
  }

  /** A fixed-window counter: one item per user per calendar minute, incremented atomically and swept by TTL. */
  async function countTowardsRate(userId: string) {
    const nowSec = Math.floor(Date.now() / 1000);
    const { Attributes } = await db.send(new UpdateCommand({
      TableName, Key: { pk: `RATE#${userId}`, sk: String(Math.floor(nowSec / 60)) },
      UpdateExpression: "ADD n :one SET #ttl = :ttl", ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":ttl": nowSec + 120 }, ReturnValues: "UPDATED_NEW",
    }));
    if (Number(Attributes?.n) > RATE_PER_MIN) throw new Conflict(`Slow down: ${RATE_PER_MIN} messages a minute.`);
  }

  /** The condition makes the same atomic increment that allocates the seq also prove the chat is in this room. */
  async function nextSeq(at: ChatRef): Promise<number> {
    try {
      const { Attributes } = await db.send(new UpdateCommand({
        TableName, Key: counterKey(at.chatId), UpdateExpression: "ADD lastSeq :one", ConditionExpression: "roomId = :r",
        ExpressionAttributeValues: { ":one": 1, ":r": at.roomId }, ReturnValues: "UPDATED_NEW",
      }));
      return Number(Attributes!.lastSeq);
    } catch (e) {
      if (conditionFailed(e)) throw new NotFound("Chat not found.");
      throw e;
    }
  }

  async function storedMessage(at: ChatRef, seq: number): Promise<StoredMessage> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: messageKey(at, seq), ConsistentRead: true }));
    if (!Item || Item.roomId !== at.roomId) throw new NotFound("Message not found.");
    return Item as StoredMessage;
  }

  async function roomMembers(roomId: string) {
    const { Items = [] } = await db.send(new QueryCommand({
      TableName, KeyConditionExpression: "pk = :p AND begins_with(sk, :m)", ProjectionExpression: "userId, username",
      ExpressionAttributeValues: { ":p": roomKey(roomId), ":m": "MEMBER#" },
    }));
    return Items as User[];
  }

  /** Your own message counts as read. The condition stops a slower, older send from moving the marker back. */
  async function readOwnMessage(at: ChatRef, userId: string, seq: number) {
    try {
      await db.send(new UpdateCommand({
        TableName, Key: readKey(at, userId), UpdateExpression: "SET lastReadSeq = :s",
        ConditionExpression: "attribute_not_exists(lastReadSeq) OR lastReadSeq < :s", ExpressionAttributeValues: { ":s": seq },
      }));
    } catch (e) {
      if (!conditionFailed(e)) throw e;
    }
  }

  /**
   * Best effort: the message is already stored, and a badge that misses one mention isn't worth failing the send.
   * Each mention counts on the chat's read state and on the member's room total (the room list's dot).
   */
  async function countMentions(at: ChatRef, userIds: string[]) {
    const add = { UpdateExpression: "ADD mentions :one", ExpressionAttributeValues: { ":one": 1 } };
    const results = await Promise.allSettled(userIds.flatMap((userId) => [
      db.send(new UpdateCommand({ TableName, Key: readKey(at, userId), ...add })),
      // The condition keeps the count from recreating a member who left in the meantime.
      db.send(new UpdateCommand({ TableName, Key: memberKey(at.roomId, userId), ConditionExpression: "attribute_exists(pk)", ...add })),
    ]));
    for (const r of results) if (r.status === "rejected" && !conditionFailed(r.reason)) console.error("mention count failed", r.reason);
  }

  async function page(chatId: string, from: number, to: number, newestFirst: boolean, limit: number) {
    if (to < from) return [];
    const { Items = [] } = await db.send(new QueryCommand({
      TableName, KeyConditionExpression: "pk = :p AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":p": chatKey(chatId), ":from": seqKey(from), ":to": seqKey(to) },
      ScanIndexForward: !newestFirst, Limit: limit,
    }));
    return newestFirst ? Items.reverse() : Items;
  }

  return {
    async send(user: User, input: ChatRef & { clientId: string; text: unknown; replyToSeq?: number; attachments?: unknown }): Promise<Message> {
      const at = { roomId: input.roomId, chatId: input.chatId };
      const text = messageText(input.text);
      const attachments = attachmentList(input.attachments, at.roomId, user.userId);
      if (!text && !attachments.length) throw new ValidationError(NEEDS_CONTENT);
      await member(at.roomId, user.userId, { writing: true });
      await countTowardsRate(user.userId);
      const quoted = input.replyToSeq === undefined ? undefined : await storedMessage(at, input.replyToSeq);
      const members = text.includes("@") ? await roomMembers(at.roomId) : [];
      const { mentions, everyone } = parseMentions(text, members);

      // Everything that can refuse the send runs before this, so a refusal never leaves a gap in the seqs.
      const seq = await nextSeq(at);
      const message: Message = {
        ...at, seq, authorId: user.userId, authorName: user.username, clientId: input.clientId, text,
        createdAt: new Date().toISOString(), attachments, reactions: {}, mentions, everyone,
        ...(quoted && { replyTo: { seq: quoted.seq, authorName: quoted.authorName, excerpt: excerpt(forReaders(quoted).text) } }),
      };
      await db.send(new PutCommand({
        TableName, Item: { ...messageKey(at, seq), ...message, textLower: text.toLowerCase() },
        ConditionExpression: "attribute_not_exists(sk)",
      }));
      const notified = everyone ? members.map((m) => m.userId) : mentions;
      await Promise.all([
        readOwnMessage(at, user.userId, seq),
        countMentions(at, notified.filter((id) => id !== user.userId)),
      ]);
      return message;
    },

    /** The old text is kept as a version item in the same transaction, so no edit ever loses what it replaced. */
    async edit(user: User, input: ChatRef & { seq: number; text: unknown }): Promise<Message> {
      const at = { roomId: input.roomId, chatId: input.chatId };
      const text = messageText(input.text);
      await member(at.roomId, user.userId, { writing: true });
      const old = await storedMessage(at, input.seq);
      const now = Date.now();
      if (!canEdit(old, user.userId, now)) throw new Forbidden("You can edit only your own messages, for 15 minutes.");
      if (!text && !old.attachments.length) throw new ValidationError(NEEDS_CONTENT);
      const editedAt = new Date(now).toISOString();
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName, Item: { pk: chatKey(at.chatId), sk: versionKey(input.seq, editedAt), text: old.text } } },
            {
              Update: {
                TableName, Key: messageKey(at, input.seq),
                UpdateExpression: "SET #text = :text, textLower = :lower, editedAt = :at",
                // The rules again, plus "the text is still what we saved as the version", so a delete or another edit
                // landing between the read and this write can't be overwritten.
                ConditionExpression: "authorId = :me AND attribute_not_exists(deleted) AND createdAt >= :cutoff AND #text = :old",
                ExpressionAttributeNames: { "#text": "text" },
                ExpressionAttributeValues: {
                  ":text": text, ":lower": text.toLowerCase(), ":at": editedAt, ":me": user.userId, ":old": old.text,
                  ":cutoff": new Date(now - EDIT_WINDOW_SEC * 1000).toISOString(),
                },
              },
            },
          ],
        }));
      } catch (e) {
        if (conditionFailed(e)) throw new Conflict("That message just changed; try again.");
        throw e;
      }
      return toMessage({ ...old, text, editedAt });
    },

    /** Marks the message deleted; the stored text stays, and readers get it blanked. */
    async remove(user: User, input: ChatRef & { seq: number }): Promise<Message> {
      const at = { roomId: input.roomId, chatId: input.chatId };
      const role = await member(at.roomId, user.userId, { writing: true });
      const msg = await storedMessage(at, input.seq);
      if (msg.deleted) throw new Conflict("That message is already deleted.");
      const deleted = deleteMode(msg, user.userId, role, Date.now());
      if (!deleted) throw new Forbidden("You can delete only your own messages, for 15 minutes.");
      try {
        await db.send(new UpdateCommand({
          TableName, Key: messageKey(at, input.seq), UpdateExpression: "SET deleted = :d",
          ConditionExpression: "attribute_not_exists(deleted)", ExpressionAttributeValues: { ":d": deleted },
        }));
      } catch (e) {
        if (conditionFailed(e)) throw new Conflict("That message is already deleted.");
        throw e;
      }
      return toMessage({ ...msg, deleted });
    },

    /** Set ADD/DELETE make a double tap harmless: adding someone twice or removing someone absent changes nothing. */
    async react(user: User, input: ChatRef & { seq: number; reaction: Reaction; on: boolean }): Promise<Message> {
      const at = { roomId: input.roomId, chatId: input.chatId };
      await member(at.roomId, user.userId, { writing: true });
      try {
        const { Attributes } = await db.send(new UpdateCommand({
          TableName, Key: messageKey(at, input.seq), UpdateExpression: `${input.on ? "ADD" : "DELETE"} reactions.#k :me`,
          ConditionExpression: "roomId = :r AND attribute_not_exists(deleted)", ExpressionAttributeNames: { "#k": input.reaction },
          ExpressionAttributeValues: { ":me": new Set([user.userId]), ":r": at.roomId }, ReturnValues: "ALL_NEW",
        }));
        return toMessage(Attributes!);
      } catch (e) {
        if (conditionFailed(e)) throw new NotFound("Message not found.");
        throw e;
      }
    },

    /** Typing is relayed only for someone who may post in the room. */
    async assertCanPost(userId: string, roomId: string): Promise<void> {
      await member(roomId, userId, { writing: true });
    },

    /**
     * Moves the read marker forward, clears the chat's mentions and takes the same number off the member's room total,
     * in one transaction. Optimistic: the write only applies if the mentions are still the count we read, so a mention
     * arriving meanwhile is never wiped without being subtracted; on a clash it reads again and retries.
     */
    async markRead(user: User, input: ChatRef & { seq: number }): Promise<{ lastReadSeq: number }> {
      const at = { roomId: input.roomId, chatId: input.chatId };
      await member(at.roomId, user.userId);
      for (let attempt = 0; attempt < 3; attempt++) {
        const { Item } = await db.send(new GetCommand({ TableName, Key: readKey(at, user.userId), ConsistentRead: true }));
        const read = Number(Item?.lastReadSeq ?? 0);
        const mentions = Number(Item?.mentions ?? 0);
        const lastReadSeq = Math.max(read, input.seq);
        if (lastReadSeq === read && mentions === 0) return { lastReadSeq };
        try {
          await db.send(new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName, Key: readKey(at, user.userId), UpdateExpression: "SET lastReadSeq = :last, mentions = :zero",
                  ConditionExpression: "(attribute_not_exists(mentions) OR mentions = :m) AND (attribute_not_exists(lastReadSeq) OR lastReadSeq <= :last)",
                  ExpressionAttributeValues: { ":last": lastReadSeq, ":zero": 0, ":m": mentions },
                },
              },
              ...(mentions ? [{
                Update: {
                  TableName, Key: memberKey(at.roomId, user.userId), UpdateExpression: "ADD mentions :minus",
                  ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":minus": -mentions },
                },
              }] : []),
            ],
          }));
          return { lastReadSeq };
        } catch (e) {
          if (!conditionFailed(e)) throw e;
        }
      }
      throw new Conflict("Your read state kept changing; try again.");
    },

    /**
     * Oldest to newest, at most a page: the newest messages, or those before or after a seq, or half a page either
     * side of one (for jumping to a quoted message). The chat's counter item proves the chat is in this room.
     */
    async history(user: User, roomId: string, chatId: string, cursor: Cursor): Promise<{ messages: Message[] }> {
      await member(roomId, user.userId);
      const { Item: counter } = await db.send(new GetCommand({ TableName, Key: counterKey(chatId) }));
      if (counter?.roomId !== roomId) throw new NotFound("Chat not found.");
      const { before, after, around } = cursor;
      const items = around !== undefined
        ? [...await page(chatId, 0, around - 1, true, PAGE / 2), ...await page(chatId, around, LAST_SEQ, false, PAGE / 2)]
        : after !== undefined
          ? await page(chatId, after + 1, LAST_SEQ, false, PAGE)
          : await page(chatId, 0, before === undefined ? LAST_SEQ : before - 1, true, PAGE);
      return { messages: items.map(toMessage) };
    },
  };
}

export type ChatRepo = ReturnType<typeof chatRepo>;
