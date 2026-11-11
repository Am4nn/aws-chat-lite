import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { auditRepo } from "../audit/repo.js";
import type { User } from "../lib/auth.js";
import { docClient, failedAt, tableName, transactionConflict } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";
import { roomKey } from "../lib/keys.js";
import type { Message } from "../chat/model.js";
import type { ModelPick } from "../models/catalog.js";
import { resolvePick } from "../models/picks.js";
import { mergeTaint, messageTaint, type TaintSource } from "../models/privacy.js";
import { summary, threadSk } from "../threads/model.js";
import type { RunEvent } from "../threads/types.js";
import { threadsRepo } from "../threads/repo.js";
import { finishRun } from "./finish.js";
import { DEAD_AFTER_MS, DEAD_REASON } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, setFields, type Run, type TransactItem } from "./repo.js";

const CLAIM_ATTEMPTS = 5;

let lambda: LambdaClient | undefined;

/** A room that never set a default model uses Auto. Read consistently, so a default an admin just set applies. */
async function roomDefaultModel(roomId: string): Promise<ModelPick> {
  const { Item } = await docClient().send(new GetCommand({
    TableName: tableName(), Key: { pk: roomKey(roomId), sk: "META" }, ConsistentRead: true,
    ProjectionExpression: "#m", ExpressionAttributeNames: { "#m": "defaultModel" },
  }));
  return (Item?.defaultModel as ModelPick | undefined) ?? "auto";
}

/**
 * The thread's ADD clause: its rev, and the message's taint when it has any. The taint is a string set, so adding to
 * it never drops a source another write added, and a thread that went private stays private.
 */
function threadAdds(taint: TaintSource[]) {
  const tainted = taint.length > 0;
  return {
    clause: `ADD #rev :one${tainted ? ", #taint :taint" : ""}`,
    names: { "#rev": "rev", ...(tainted && { "#taint": "taint" }) },
    values: { ":one": 1, ...(tainted && { ":taint": new Set(taint) }) },
  };
}

/**
 * True when the claim went through; false when the thread already has a live run, which makes the message a steer.
 * A claim that clashes with another write to the thread is tried again: if the clash was another message starting
 * the run, the retry finds that run and the message becomes its steer. `replaced` (item 3, a dead run being marked
 * failed) failing means that run closed itself meanwhile, so the claim goes ahead without it.
 */
async function claimed(items: TransactItem[], replaced?: TransactItem): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await docClient().send(new TransactWriteCommand({ TransactItems: replaced ? [...items, replaced] : items }));
      return true;
    } catch (e) {
      if (failedAt(e, 1)) return false;
      if (replaced && failedAt(e, 2)) replaced = undefined;
      else if (!transactionConflict(e) || attempt === CLAIM_ATTEMPTS) throw e;
    }
  }
}

/**
 * Hands a thread message to the agent. With no run active, one transaction writes a new run and makes it the
 * thread's active run, then the run's durable execution is started. With a run active, the message is a steer: it is
 * already in the thread, past the run's cursor, and the run reads it before its next model call.
 *
 * A run past its `deadAt` can't still be alive, so it no longer counts as active, and the claim marks it failed as it
 * takes the thread.
 *
 * A new run takes the message's `pick`, else the room default; a default that may not see a private thread's content
 * becomes Auto. A steer's pick is ignored: the run keeps the model it started with. Either way a message with an
 * attachment makes the thread private.
 */
export async function startOrSteer(
  user: User, roomId: string, threadId: string, message: Message, pick?: ModelPick,
): Promise<{ runId: string; started: boolean }> {
  const db = docClient();
  const TableName = tableName();
  const runs = runsRepo();
  const threads = threadsRepo();
  const [thread, roomDefault] = await Promise.all([threads.threadById(roomId, threadId), roomDefaultModel(roomId)]);
  if (!thread) throw new NotFound("Thread not found.");
  const taint = messageTaint(message);
  const adds = threadAdds(taint);
  const chosen = resolvePick(pick, roomDefault, mergeTaint(thread.taint, taint));
  const key = { pk: roomKey(roomId), sk: threadSk(thread.number) };
  const now = new Date();
  const startedAt = now.toISOString();
  const deadAt = new Date(now.getTime() + DEAD_AFTER_MS).toISOString();
  const run: Run = {
    runId: randomUUID(), roomId, threadId, number: thread.number, status: "running", pick: chosen.pick, pickBy: chosen.by,
    startedBy: user.username, startedAt, deadAt, firstSeq: message.seq, seenSeq: message.seq, steps: 0, costMicros: 0,
  };
  const start = setFields({
    activeRunId: run.runId, runId: run.runId, runFirstSeq: message.seq, status: "running", startedAt, deadAt, steps: 0, costMicros: 0,
    lastActivityAt: startedAt,
  });

  const claim: TransactItem[] = [
    { Put: { TableName, Item: { pk: `RUN#${run.runId}`, sk: "META", ...run }, ConditionExpression: "attribute_not_exists(pk)" } },
    {
      Update: {
        TableName, Key: key, UpdateExpression: `${start.UpdateExpression} REMOVE endedAt, currentStep, #model ${adds.clause}`,
        ConditionExpression: "attribute_not_exists(activeRunId) OR #deadAt < :now",
        ExpressionAttributeNames: { ...start.ExpressionAttributeNames, ...adds.names, "#model": "model" },
        ExpressionAttributeValues: { ...start.ExpressionAttributeValues, ...adds.values, ":now": startedAt },
      },
    },
  ];
  // A run's `deadAt` is never earlier than its start plus this, so only a run that started this long ago can be dead.
  const deadLine = new Date(now.getTime() - DEAD_AFTER_MS).toISOString();
  const last = thread.runId && (thread.startedAt ?? "") < deadLine ? await runs.getRun(thread.runId) : undefined;
  const failed = setFields({ status: "failed", reason: DEAD_REASON, endedAt: startedAt });
  const replaced: TransactItem | undefined = last?.status === "running" && last.deadAt < startedAt ? {
    Update: {
      TableName, Key: { pk: `RUN#${last.runId}`, sk: "META" }, ...failed, ConditionExpression: "#status = :running",
      ExpressionAttributeValues: { ...failed.ExpressionAttributeValues, ":running": "running" },
    },
  } : undefined;
  if (!await claimed(claim, replaced)) {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName, Key: key, UpdateExpression: `SET lastActivityAt = :now ${adds.clause}`, ExpressionAttributeNames: adds.names,
      ExpressionAttributeValues: { ":now": startedAt, ...adds.values }, ReturnValues: "ALL_NEW",
    }));
    // The run may have closed since the start failed; then it closed after reading this message, as its last steer.
    const runId = String(Attributes!.activeRunId ?? Attributes!.runId ?? "");
    await notifyRun(roomId, summary(Attributes!, Date.now()), await runs.lastEventSeq(runId));
    return { runId, started: false };
  }

  let first: RunEvent;
  try {
    first = await (await runs.eventWriter(run.runId)).append({ type: "run.started", pick: run.pick, startedBy: run.startedBy });
    await auditRepo().record(roomId, {
      id: `${run.runId}#${first.seq}`, at: first.at, actor: user.username, kind: "asked", threadNumber: thread.number, detail: message.text,
    });
    // The execution name is the run id, so a repeated start can't begin a second execution of the same run.
    await (lambda ??= new LambdaClient({})).send(new InvokeCommand({
      FunctionName: process.env.RUN_FN_NAME, Qualifier: process.env.RUN_FN_QUALIFIER, InvocationType: "Event",
      DurableExecutionName: run.runId, Payload: JSON.stringify({ runId: run.runId }),
    }));
  } catch (e) {
    console.error("run start failed", run.runId, e);
    await finishRun(run, { status: "failed", reason: "The run couldn't start." }, { seenSeq: message.seq, force: true });
    return { runId: run.runId, started: true };
  }
  const running = await threads.threadById(roomId, threadId);
  if (running) await notifyRun(roomId, running, first.seq);
  return { runId: run.runId, started: true };
}
