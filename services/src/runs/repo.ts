import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { conditionFailed, docClient, failedAt, queryAll, tableName } from "../lib/db.js";
import { LAST_SEQ, forReaders, seqKey, type Message, type StoredMessage } from "../chat/model.js";
import { summary, threadSk } from "../threads/model.js";
import type { RunEndStatus, RunEvent, RunEventBody, ThreadSummary } from "../threads/types.js";
import { eventSk } from "./model.js";

/** A run's META item: one durable execution answering one thread message (plus any steers it reads). */
export type Run = {
  runId: string;
  roomId: string;
  threadId: string;
  number: number;
  status: "running" | RunEndStatus;
  model: string;
  startedBy: string;
  startedAt: string;
  endedAt?: string;
  reason?: string;
  /** The message that started the run. */
  firstSeq: number;
  /** The newest thread message the run has read. */
  seenSeq: number;
  steps: number;
  costMicros: number;
  stopRequestedBy?: string;
  answerSeq?: number;
};

type Item = Record<string, unknown>;

const MODEL_CONTEXT = 50;
const FORCED_CLOSE_ATTEMPTS = 5;

const runKey = (runId: string) => ({ pk: `RUN#${runId}`, sk: "META" });
const chatMetaKey = (threadId: string) => ({ pk: `CHAT#${threadId}`, sk: "META" });
const threadKey = (run: Run) => ({ pk: `ROOM#${run.roomId}`, sk: threadSk(run.number) });

/**
 * `SET #f = :f, …` for each defined field. Every attribute name goes through a placeholder: DynamoDB rejects reserved
 * words such as `status` and `steps` written bare in an expression.
 */
export function setFields(fields: Record<string, unknown>) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  return {
    UpdateExpression: `SET ${keys.map((k) => `#${k} = :${k}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(keys.map((k) => [`#${k}`, k])),
    ExpressionAttributeValues: Object.fromEntries(keys.map((k) => [`:${k}`, fields[k]])),
  };
}

const withoutKeys = ({ pk: _pk, sk: _sk, ...rest }: Item) => rest;

/**
 * A stored message without its attachment links (the model doesn't read them, and an agent's answer has none), so the
 * run needs no access to the files bucket.
 */
const asMessage = (item: Item): Message => forReaders({ ...withoutKeys(item), reactions: {} } as StoredMessage);

/**
 * Runs and their event logs (single table). The run loop is the only writer of a run's events, so their seqs come
 * from the newest stored event rather than a shared counter.
 */
export function runsRepo() {
  const db = docClient();
  const TableName = tableName();

  async function getRun(runId: string): Promise<Run | undefined> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: runKey(runId), ConsistentRead: true }));
    return Item && (withoutKeys(Item) as Run);
  }

  async function lastEventSeq(runId: string): Promise<number> {
    const { Items = [] } = await db.send(new QueryCommand({
      TableName, KeyConditionExpression: "pk = :p AND begins_with(sk, :ev)", ScanIndexForward: false, Limit: 1,
      ConsistentRead: true, ExpressionAttributeValues: { ":p": `RUN#${runId}`, ":ev": "EV#" },
    }));
    return Number(Items[0]?.seq ?? 0);
  }

  async function chatLastSeq(threadId: string): Promise<number> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: chatMetaKey(threadId), ConsistentRead: true }));
    return Number(Item?.lastSeq ?? 0);
  }

  /** The answer an earlier close posted, for a close that is repeated. */
  async function storedAnswer(run: Run): Promise<Message | undefined> {
    const seq = (await getRun(run.runId))?.answerSeq;
    if (seq === undefined) return undefined;
    const { Item } = await db.send(new GetCommand({ TableName, Key: { pk: `CHAT#${run.threadId}`, sk: seqKey(seq) }, ConsistentRead: true }));
    return Item && asMessage(Item);
  }

  return {
    lastEventSeq,
    getRun,
    /** The thread chat's counter: the newest seq any send has taken, written or not. */
    chatLastSeq,

    /**
     * Appends events after the newest stored one. Each put waits for the one before it, so events land in seq order
     * even when appends overlap, and the condition refuses to overwrite a seq that is already taken.
     */
    async eventWriter(runId: string): Promise<{ append(b: RunEventBody): Promise<RunEvent> }> {
      let seq = await lastEventSeq(runId);
      let tail: Promise<unknown> = Promise.resolve();
      return {
        append(body) {
          const event = { ...body, seq: ++seq, at: new Date().toISOString() } as RunEvent;
          const put = tail.then(() => db.send(new PutCommand({
            TableName, Item: { pk: `RUN#${runId}`, sk: eventSk(event.seq), ...event }, ConditionExpression: "attribute_not_exists(sk)",
          })));
          tail = put;
          return put.then(() => event);
        },
      };
    },

    async events(runId: string, afterSeq: number, limit = 100): Promise<RunEvent[]> {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName, KeyConditionExpression: "pk = :p AND sk BETWEEN :from AND :to", ConsistentRead: true, Limit: limit,
        ExpressionAttributeValues: { ":p": `RUN#${runId}`, ":from": eventSk(afterSeq + 1), ":to": eventSk(LAST_SEQ) },
      }));
      return Items.map((i) => withoutKeys(i) as RunEvent);
    },

    async allEvents(runId: string): Promise<RunEvent[]> {
      const items = await queryAll({
        KeyConditionExpression: "pk = :p AND begins_with(sk, :ev)", ConsistentRead: true,
        ExpressionAttributeValues: { ":p": `RUN#${runId}`, ":ev": "EV#" },
      });
      return items.map((i) => withoutKeys(i) as RunEvent);
    },

    /** Thread messages after the run's cursor: the steers it hasn't read yet. */
    async unread(threadId: string, afterSeq: number): Promise<Message[]> {
      const items = await queryAll({
        KeyConditionExpression: "pk = :p AND sk BETWEEN :from AND :to", ConsistentRead: true,
        ExpressionAttributeValues: { ":p": `CHAT#${threadId}`, ":from": seqKey(afterSeq + 1), ":to": seqKey(LAST_SEQ) },
      });
      return items.map(asMessage);
    },

    /** The newest messages up to and including `uptoSeq`, oldest first: the thread as the run found it. */
    async prior(threadId: string, uptoSeq: number): Promise<Message[]> {
      const { Items = [] } = await db.send(new QueryCommand({
        TableName, KeyConditionExpression: "pk = :p AND sk BETWEEN :from AND :to", ConsistentRead: true,
        ScanIndexForward: false, Limit: MODEL_CONTEXT,
        ExpressionAttributeValues: { ":p": `CHAT#${threadId}`, ":from": seqKey(0), ":to": seqKey(uptoSeq) },
      }));
      return Items.reverse().map(asMessage);
    },

    /** The run's live numbers, on the run and on its thread (where members see them). */
    async progress(run: Run, fields: { steps?: number; currentStep?: string; costMicros?: number }): Promise<ThreadSummary> {
      const set = setFields(fields);
      const [, { Attributes }] = await Promise.all([
        db.send(new UpdateCommand({ TableName, Key: runKey(run.runId), ...set })),
        db.send(new UpdateCommand({
          TableName, Key: threadKey(run), ...set, UpdateExpression: `${set.UpdateExpression} ADD #rev :one`,
          ExpressionAttributeNames: { ...set.ExpressionAttributeNames, "#rev": "rev" },
          ExpressionAttributeValues: { ...set.ExpressionAttributeValues, ":one": 1 }, ReturnValues: "ALL_NEW",
        })),
      ]);
      return summary(Attributes!, Date.now());
    },

    /** A tool returned: the thread no longer names a current step until the next one starts. */
    async stepDone(run: Run): Promise<ThreadSummary> {
      const { Attributes } = await db.send(new UpdateCommand({
        TableName, Key: threadKey(run), UpdateExpression: "REMOVE currentStep ADD #rev :one",
        ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":one": 1 }, ReturnValues: "ALL_NEW",
      }));
      return summary(Attributes!, Date.now());
    },

    /** Asks a running run to stop; false when it is no longer running. */
    async flagStop(runId: string, username: string): Promise<boolean> {
      try {
        await db.send(new UpdateCommand({
          TableName, Key: runKey(runId), UpdateExpression: "SET stopRequestedBy = :by", ConditionExpression: "#status = :running",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":by": username, ":running": "running" },
        }));
        return true;
      } catch (e) {
        if (conditionFailed(e)) return false;
        throw e;
      }
    },

    /**
     * Posts the answer and ends the run in one transaction:
     * 1. the thread chat's counter moves to the answer's seq, only if it is still `seenSeq`;
     * 2. the answer message goes in at that seq;
     * 3. the thread drops its active run and shows how it ended;
     * 4. the run records its answer, only if it has none yet.
     *
     * Item 1 failing means a member wrote after the run's last read: "unread", and the run stays open to read it.
     * A forced close (stop, cap, limits, errors) instead lands after whatever is there. Item 4 failing means an
     * earlier attempt already closed the run: "already", with the answer it stored.
     */
    async closeRun(
      run: Run, opts: { status: RunEndStatus; reason?: string; text: string; summary: string; seenSeq: number; force: boolean },
    ): Promise<{ result: "closed" | "unread" | "already"; answer?: Message }> {
      const { status, reason, text, force } = opts;
      let seen = opts.seenSeq;
      for (let attempt = 1; ; attempt++) {
        const now = new Date().toISOString();
        const seq = seen + 1;
        const answer: Message = {
          roomId: run.roomId, chatId: run.threadId, seq, authorId: "agent", authorName: "agent", text, createdAt: now,
          attachments: [], reactions: {}, mentions: [], everyone: false,
          agent: {
            runId: run.runId, status, reason, steps: run.steps, costMicros: run.costMicros,
            ms: Date.parse(now) - Date.parse(run.startedAt), model: run.model, firstSeq: run.firstSeq,
          },
        };
        const thread = setFields({
          status, summary: opts.summary, endedAt: now, lastActivityAt: now, steps: run.steps,
          costMicros: run.costMicros,
        });
        const closed = setFields({ status, reason, answerSeq: seq, seenSeq: seen, endedAt: now, steps: run.steps, costMicros: run.costMicros });
        try {
          await db.send(new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName, Key: chatMetaKey(run.threadId), UpdateExpression: "SET lastSeq = :next",
                  ConditionExpression: "lastSeq = :seen", ExpressionAttributeValues: { ":next": seq, ":seen": seen },
                },
              },
              { Put: { TableName, Item: { pk: `CHAT#${run.threadId}`, sk: seqKey(seq), ...answer, textLower: text.toLowerCase() } } },
              {
                Update: {
                  TableName, Key: threadKey(run), ...thread,
                  UpdateExpression: `${thread.UpdateExpression} REMOVE activeRunId, currentStep ADD #rev :one`,
                  ExpressionAttributeNames: { ...thread.ExpressionAttributeNames, "#rev": "rev" },
                  ExpressionAttributeValues: { ...thread.ExpressionAttributeValues, ":one": 1 },
                },
              },
              { Update: { TableName, Key: runKey(run.runId), ...closed, ConditionExpression: "attribute_not_exists(answerSeq)" } },
            ],
          }));
          return { result: "closed", answer };
        } catch (e) {
          if (failedAt(e, 3)) return { result: "already", answer: await storedAnswer(run) };
          if (!failedAt(e, 0)) throw e;
          if (!force) return { result: "unread" };
          if (attempt === FORCED_CLOSE_ATTEMPTS) throw e;
          seen = await chatLastSeq(run.threadId);
        }
      }
    },
  };
}
