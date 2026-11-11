import {
  GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { conditionFailed, docClient, failedAt, queryAll, tableName } from "../lib/db.js";
import { LAST_SEQ, forReaders, seqKey, type Message, type StoredMessage } from "../chat/model.js";
import type { ModelPick } from "../models/catalog.js";
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
  /** What the run was asked to use: the message's own pick, or the room default. */
  pick: ModelPick;
  pickBy: "pick" | "default";
  /** The model id it routed to; unset until it has routed. */
  model?: string;
  startedBy: string;
  startedAt: string;
  /** Past this the run can't be alive: the claim plus the execution's own limit, moved past each approval's expiry. */
  deadAt: string;
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
  /** Set while the run waits on the approval for this step. */
  waitingStep?: number;
  /** Time spent waiting on approvals, which the run's time limit leaves out. */
  pausedMs?: number;
};

type Item = Record<string, unknown>;
export type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

const MODEL_CONTEXT = 50;
const FORCED_CLOSE_ATTEMPTS = 5;

const runKey = (runId: string) => ({ pk: `RUN#${runId}`, sk: "META" });
const chatMetaKey = (threadId: string) => ({ pk: `CHAT#${threadId}`, sk: "META" });
const threadKey = (run: Run) => ({ pk: `ROOM#${run.roomId}`, sk: threadSk(run.number) });
const callKey = (runId: string, call: string) => ({ pk: `RUN#${runId}`, sk: `CALL#${call}` });
/**
 * Every run write to its thread is conditioned on the run still being the thread's: a run that was replaced (it was
 * presumed dead) must not overwrite the run that took its place.
 */
const whileOwned = (run: Run) => ({ ConditionExpression: "activeRunId = :runId", values: { ":runId": run.runId } });

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

  /** A conditional write to a run's thread: the thread as it now stands, or null when the run no longer owns it. */
  async function threadUpdate(update: UpdateCommand): Promise<ThreadSummary | null> {
    try {
      const { Attributes } = await db.send(update);
      return summary(Attributes!, Date.now());
    } catch (e) {
      if (conditionFailed(e)) return null;
      throw e;
    }
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
     * even when appends overlap, and the condition refuses to overwrite a seq that is already taken. Writes passed in
     * `with` go in one transaction with the event, so they happen exactly when it does.
     */
    async eventWriter(runId: string): Promise<{ append(b: RunEventBody, alongside?: TransactItem[]): Promise<RunEvent> }> {
      let seq = await lastEventSeq(runId);
      let tail: Promise<unknown> = Promise.resolve();
      return {
        append(body, alongside = []) {
          const event = { ...body, seq: ++seq, at: new Date().toISOString() } as RunEvent;
          const put = {
            TableName, Item: { pk: `RUN#${runId}`, sk: eventSk(event.seq), ...event }, ConditionExpression: "attribute_not_exists(sk)",
          };
          const write = tail.then((): Promise<unknown> => (alongside.length
            ? db.send(new TransactWriteCommand({ TransactItems: [{ Put: put }, ...alongside] }))
            : db.send(new PutCommand(put))));
          tail = write;
          return write.then(() => event);
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

    /**
     * The step result a model call recorded with its usage (see `callMarker`), or undefined when the call hasn't
     * finished yet.
     */
    async recorded<T>(runId: string, call: string): Promise<T | undefined> {
      const { Item } = await db.send(new GetCommand({ TableName, Key: callKey(runId, call), ConsistentRead: true }));
      return Item?.result as T | undefined;
    },

    /** Marks a model call as recorded, with its step's result; refused when an earlier attempt already did. */
    callMarker(runId: string, call: string, result: unknown): TransactItem {
      return { Put: { TableName, Item: { ...callKey(runId, call), result }, ConditionExpression: "attribute_not_exists(sk)" } };
    },

    /** The run's live numbers, on the run and on its thread (where members see them). Null once the thread isn't its. */
    async progress(run: Run, fields: { steps?: number; currentStep?: string; costMicros?: number }): Promise<ThreadSummary | null> {
      const set = setFields(fields);
      const owned = whileOwned(run);
      const [, thread] = await Promise.all([
        db.send(new UpdateCommand({ TableName, Key: runKey(run.runId), ...set })),
        threadUpdate(new UpdateCommand({
          TableName, Key: threadKey(run), ...set, UpdateExpression: `${set.UpdateExpression} ADD #rev :one`,
          ConditionExpression: owned.ConditionExpression, ExpressionAttributeNames: { ...set.ExpressionAttributeNames, "#rev": "rev" },
          ExpressionAttributeValues: { ...set.ExpressionAttributeValues, ...owned.values, ":one": 1 }, ReturnValues: "ALL_NEW",
        })),
      ]);
      return thread;
    },

    /** A tool returned: the thread no longer names a current step until the next one starts. */
    async stepDone(run: Run): Promise<ThreadSummary | null> {
      const owned = whileOwned(run);
      return threadUpdate(new UpdateCommand({
        TableName, Key: threadKey(run), UpdateExpression: "REMOVE currentStep ADD #rev :one", ConditionExpression: owned.ConditionExpression,
        ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ...owned.values, ":one": 1 }, ReturnValues: "ALL_NEW",
      }));
    },

    /** The model the run routed to, which its answer names. */
    async setModel(runId: string, model: string): Promise<void> {
      await db.send(new UpdateCommand({ TableName, Key: runKey(runId), ...setFields({ model }) }));
    },

    /** Asks a running run to stop. Returns the run as flagged, or undefined when it is no longer running. */
    async flagStop(runId: string, username: string): Promise<Run | undefined> {
      try {
        const { Attributes } = await db.send(new UpdateCommand({
          TableName, Key: runKey(runId), UpdateExpression: "SET stopRequestedBy = :by", ConditionExpression: "#status = :running",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":by": username, ":running": "running" },
          ReturnValues: "ALL_NEW",
        }));
        return withoutKeys(Attributes!) as Run;
      } catch (e) {
        if (conditionFailed(e)) return undefined;
        throw e;
      }
    },

    /**
     * The run waits on a member: its thread shows the approval, and its dead time moves past the approval's expiry.
     * The stop flag comes back from the same write, so a stop that landed before it is seen here.
     */
    async markWaiting(
      run: Run, approval: { step: number; title: string; expiresAt: string }, deadAt: string,
    ): Promise<{ thread: ThreadSummary | null; stopRequestedBy?: string }> {
      const set = setFields({ status: "waiting", approval, deadAt });
      const owned = whileOwned(run);
      const [{ Attributes: meta }, thread] = await Promise.all([
        db.send(new UpdateCommand({
          TableName, Key: runKey(run.runId), ...setFields({ waitingStep: approval.step, deadAt }), ReturnValues: "ALL_NEW",
        })),
        threadUpdate(new UpdateCommand({
          TableName, Key: threadKey(run), ...set, UpdateExpression: `${set.UpdateExpression} ADD #rev :one`,
          ConditionExpression: owned.ConditionExpression, ExpressionAttributeNames: { ...set.ExpressionAttributeNames, "#rev": "rev" },
          ExpressionAttributeValues: { ...set.ExpressionAttributeValues, ...owned.values, ":one": 1 }, ReturnValues: "ALL_NEW",
        })),
      ]);
      return { thread, stopRequestedBy: meta!.stopRequestedBy as string | undefined };
    },

    /**
     * Back to running once the approval settles. The wait joins the run's paused time only while the run still waits on
     * that step, so a retried settle can't count it twice.
     */
    async doneWaiting(run: Run, step: number, waitedMs: number): Promise<ThreadSummary | null> {
      try {
        await db.send(new UpdateCommand({
          TableName, Key: runKey(run.runId), UpdateExpression: "REMOVE waitingStep ADD pausedMs :waited",
          ConditionExpression: "waitingStep = :step", ExpressionAttributeValues: { ":waited": waitedMs, ":step": step },
        }));
      } catch (e) {
        if (!conditionFailed(e)) throw e;
      }
      const owned = whileOwned(run);
      return threadUpdate(new UpdateCommand({
        TableName, Key: threadKey(run), UpdateExpression: "SET #status = :running REMOVE approval ADD #rev :one",
        ConditionExpression: owned.ConditionExpression, ExpressionAttributeNames: { "#status": "status", "#rev": "rev" },
        ExpressionAttributeValues: { ":running": "running", ...owned.values, ":one": 1 }, ReturnValues: "ALL_NEW",
      }));
    },

    /**
     * Posts the answer and ends the run in one transaction:
     * 1. the thread chat's counter moves to the answer's seq, only if it is still `seenSeq`;
     * 2. the answer message goes in at that seq;
     * 3. the run records how it ended, only while it is still running;
     * 4. the thread drops its active run and shows how it ended, only while the run is still the thread's.
     *
     * Item 1 failing means a member wrote after the run's last read: "unread", and the run stays open to read it.
     * A forced close (stop, cap, limits, errors) instead lands after whatever is there. Item 3 failing means the run
     * was already closed, by an earlier attempt or as dead when a new run replaced it: "already", with any answer it
     * stored. Item 4 failing means a newer run has the thread, so the close goes ahead without touching it.
     */
    async closeRun(
      run: Run, opts: { status: RunEndStatus; reason?: string; text: string; summary: string; seenSeq: number; force: boolean },
    ): Promise<{ result: "closed" | "unread" | "already"; answer?: Message; endedAt?: string }> {
      const { status, reason, text, force } = opts;
      let seen = opts.seenSeq;
      let owns = true;
      for (let attempt = 1; ; attempt++) {
        const now = new Date().toISOString();
        const seq = seen + 1;
        const answer: Message = {
          roomId: run.roomId, chatId: run.threadId, seq, authorId: "agent", authorName: "agent", text, createdAt: now,
          attachments: [], reactions: {}, mentions: [], everyone: false,
          agent: {
            runId: run.runId, status, reason, steps: run.steps, costMicros: run.costMicros,
            ms: Date.parse(now) - Date.parse(run.startedAt), model: run.model ?? "", pick: run.pick, firstSeq: run.firstSeq,
          },
        };
        const thread = setFields({
          status, summary: opts.summary, endedAt: now, lastActivityAt: now, steps: run.steps,
          costMicros: run.costMicros,
        });
        const closed = setFields({ status, reason, answerSeq: seq, seenSeq: seen, endedAt: now, steps: run.steps, costMicros: run.costMicros });
        const ownership = whileOwned(run);
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
                  TableName, Key: runKey(run.runId), ...closed, ConditionExpression: "#status = :running",
                  ExpressionAttributeValues: { ...closed.ExpressionAttributeValues, ":running": "running" },
                },
              },
              ...(owns ? [{
                Update: {
                  TableName, Key: threadKey(run), ...thread,
                  UpdateExpression: `${thread.UpdateExpression} REMOVE activeRunId, currentStep, approval ADD #rev :one`,
                  ConditionExpression: ownership.ConditionExpression,
                  ExpressionAttributeNames: { ...thread.ExpressionAttributeNames, "#rev": "rev" },
                  ExpressionAttributeValues: { ...thread.ExpressionAttributeValues, ...ownership.values, ":one": 1 },
                },
              }] : []),
            ],
          }));
          return { result: "closed", answer, endedAt: now };
        } catch (e) {
          if (failedAt(e, 2)) return { result: "already", answer: await storedAnswer(run) };
          if (owns && failedAt(e, 3)) {
            owns = false;
            continue;
          }
          if (!failedAt(e, 0)) throw e;
          if (!force) return { result: "unread" };
          if (attempt === FORCED_CLOSE_ATTEMPTS) throw e;
          seen = await chatLastSeq(run.threadId);
        }
      }
    },
  };
}
