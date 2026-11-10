import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { conditionFailed, docClient, failedAt, tableName } from "../lib/db.js";
import { Conflict, NotFound, ValidationError } from "../lib/errors.js";
import { requireMember } from "../chat/membership.js";
import { messageText, type Message } from "../chat/model.js";
import { chatRepo } from "../chat/repo.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { PROVISIONAL, isArchived, isNumberedName, threadName, threadSk, uniqueCandidates } from "./model.js";
import type { ThreadSummary } from "./types.js";

interface User { userId: string; username: string }
type Item = Record<string, unknown>;

const roomKey = (roomId: string) => `ROOM#${roomId}`;
const threadKey = (roomId: string, n: number) => ({ pk: roomKey(roomId), sk: threadSk(n) });
const nameKey = (roomId: string, name: string) => ({ pk: roomKey(roomId), sk: `CHATNAME#${name}` });
const chatMetaKey = (threadId: string) => ({ pk: `CHAT#${threadId}`, sk: "META" });

/** A stored thread as clients get it: the bookkeeping fields stay on the server, and `archived` is worked out now. */
export function summary({ pk: _pk, sk: _sk, activeRunId: _run, named: _named, from: _from, ...rest }: Item, nowMs: number): ThreadSummary {
  const thread = rest as Omit<ThreadSummary, "archived">;
  return { ...thread, archived: isArchived(thread, nowMs) };
}

/** Best effort: the write has happened, and a client that misses the event gets the thread on its next room load. */
async function announce(thread: ThreadSummary) {
  try {
    await broadcastToRoom(thread.roomId, { type: "thread.updated", roomId: thread.roomId, thread });
  } catch (e) {
    console.error("thread.updated broadcast failed", thread.roomId, e);
  }
}

/**
 * Agent threads (single table). A thread is a chat with `kind: "thread"`, so its messages, history and search are the
 * chat's; the thread item in the room partition carries its number, name and run status.
 */
export function threadsRepo() {
  const db = docClient();
  const TableName = tableName();

  async function at(roomId: string, n: number) {
    const { Item } = await db.send(new GetCommand({ TableName, Key: threadKey(roomId, n), ConsistentRead: true }));
    return Item;
  }

  /** The thread's chat counter records its room and number, which proves the thread is in this room and finds it. */
  async function byId(roomId: string, threadId: string) {
    const { Item: chat } = await db.send(new GetCommand({ TableName, Key: chatMetaKey(threadId), ConsistentRead: true }));
    if (chat?.kind !== "thread" || chat.roomId !== roomId) return undefined;
    return at(roomId, Number(chat.number));
  }

  /**
   * One transaction: the old name's guard goes (only while it is still this thread's), the new one is claimed (only
   * if free), and the thread changes only if it still has the name we read, so of two renames at once only one wins.
   * Item 1 failing means the name is taken.
   */
  async function moveName(thread: Item, name: string): Promise<ThreadSummary> {
    const roomId = String(thread.roomId);
    const threadId = String(thread.threadId);
    await db.send(new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName, Key: nameKey(roomId, String(thread.name)), ConditionExpression: "chatId = :t",
            ExpressionAttributeValues: { ":t": threadId },
          },
        },
        { Put: { TableName, Item: { ...nameKey(roomId, name), chatId: threadId, kind: "thread" }, ConditionExpression: "attribute_not_exists(pk)" } },
        {
          Update: {
            TableName, Key: threadKey(roomId, Number(thread.number)),
            UpdateExpression: "SET #name = :new, #named = :true ADD #rev :one", ConditionExpression: "#name = :old",
            ExpressionAttributeNames: { "#name": "name", "#named": "named", "#rev": "rev" },
            ExpressionAttributeValues: { ":new": name, ":old": thread.name, ":true": true, ":one": 1 },
          },
        },
      ],
    }));
    // Re-read rather than add 1 to the rev we read: a run may have written the thread in between.
    return summary((await at(roomId, Number(thread.number)))!, Date.now());
  }

  return {
    /**
     * The room's counter hands out the number, so concurrent starts get #1, #2… with no gaps. The thread, its chat
     * and its name guard are written together, then the first message is sent into the new chat.
     */
    async createThread(user: User, roomId: string, input: { text: unknown; clientId: string; from?: { chatId: string; seq: number } }): Promise<{ thread: ThreadSummary; message: Message }> {
      if (!messageText(input.text)) throw new ValidationError("A thread starts with a message.");
      await requireMember(roomId, user.userId, { writing: true });
      const { Attributes } = await db.send(new UpdateCommand({
        TableName, Key: { pk: roomKey(roomId), sk: "META" }, UpdateExpression: "ADD threadSeq :one",
        ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":one": 1 }, ReturnValues: "UPDATED_NEW",
      }));
      const number = Number(Attributes!.threadSeq);
      const threadId = randomUUID();
      const name = PROVISIONAL(number);
      const item = {
        ...threadKey(roomId, number), roomId, threadId, number, name, named: false, status: "idle", rev: 1, steps: 0,
        costMicros: 0, createdBy: user.userId, lastActivityAt: new Date().toISOString(), ...(input.from && { from: input.from }),
      };
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName, Item: item } },
          { Put: { TableName, Item: { ...chatMetaKey(threadId), roomId, lastSeq: 0, kind: "thread", number } } },
          { Put: { TableName, Item: { ...nameKey(roomId, name), chatId: threadId, kind: "thread" }, ConditionExpression: "attribute_not_exists(pk)" } },
        ],
      }));
      const message = await chatRepo().send(user, { roomId, chatId: threadId, clientId: input.clientId, text: input.text });
      const thread = summary(item, Date.now());
      await announce(thread);
      return { thread, message };
    },

    /** Any member may rename. `name` is already validated. */
    async rename(user: User, roomId: string, threadId: string, name: string): Promise<ThreadSummary> {
      await requireMember(roomId, user.userId, { writing: true });
      const thread = await byId(roomId, threadId);
      if (!thread) throw new NotFound("Thread not found.");
      if (thread.name === name) return summary(thread, Date.now());
      let renamed: ThreadSummary;
      try {
        renamed = await moveName(thread, name);
      } catch (e) {
        if (conditionFailed(e)) throw new Conflict(`#${name} is taken.`);
        throw e;
      }
      await announce(renamed);
      return renamed;
    },

    /**
     * Names a thread from the model's suggestion unless someone already named it: the suggestion, then -2 to -9 when
     * taken. Null when the thread keeps its provisional name (named meanwhile, an unusable suggestion, or all taken).
     */
    async nameIfProvisional(roomId: string, threadId: string, suggestion: string): Promise<ThreadSummary | null> {
      const thread = await byId(roomId, threadId);
      if (!thread || thread.named) return null;
      let base: string;
      try {
        base = threadName(suggestion);
      } catch {
        return null;
      }
      for (const name of uniqueCandidates(base).filter((n) => !isNumberedName(n))) {
        try {
          return await moveName(thread, name);
        } catch (e) {
          if (!conditionFailed(e)) throw e;
          if (!failedAt(e, 1)) return null;
        }
      }
      return null;
    },

    async threadById(roomId: string, threadId: string): Promise<ThreadSummary | null> {
      const thread = await byId(roomId, threadId);
      return thread ? summary(thread, Date.now()) : null;
    },

    /** `#12` by number, `#name` through the name guard, which a chat's name also uses (those aren't threads). */
    async threadByTag(roomId: string, tag: { number: number } | { name: string }): Promise<ThreadSummary | null> {
      let thread: Item | undefined;
      if ("number" in tag) {
        thread = await at(roomId, tag.number);
      } else {
        const { Item: guard } = await db.send(new GetCommand({ TableName, Key: nameKey(roomId, tag.name), ConsistentRead: true }));
        thread = guard?.kind === "thread" ? await byId(roomId, String(guard.chatId)) : undefined;
      }
      return thread ? summary(thread, Date.now()) : null;
    },
  };
}

export type ThreadsRepo = ReturnType<typeof threadsRepo>;
