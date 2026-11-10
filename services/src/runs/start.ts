import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, failedAt, tableName, transactionConflict } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";
import type { Message } from "../chat/model.js";
import { summary, threadSk } from "../threads/model.js";
import type { RunEvent } from "../threads/types.js";
import { threadsRepo } from "../threads/repo.js";
import { finishRun } from "./finish.js";
import { DEAD_AFTER_MS } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, setFields, type Run } from "./repo.js";

interface User { userId: string; username: string }

let lambda: LambdaClient | undefined;

/**
 * True when the claim went through; false when the thread already has a live run, which makes the message a steer.
 * A claim that clashes with another write to the thread is tried once more, then also treated as a steer: the
 * message is stored either way, and the clash was most likely another message starting the run.
 */
async function claimed(claim: TransactWriteCommand): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await docClient().send(claim);
      return true;
    } catch (e) {
      if (failedAt(e, 1)) return false;
      if (!transactionConflict(e)) throw e;
      if (attempt === 2) return false;
    }
  }
}

/**
 * Hands a thread message to the agent. With no run active, one transaction writes a new run and makes it the
 * thread's active run, then the run's durable execution is started. With a run active, the message is a steer: it is
 * already in the thread, past the run's cursor, and the run reads it before its next model call.
 *
 * A run whose `startedAt` is older than the execution timeout can't still be alive, so it no longer counts as active.
 */
export async function startOrSteer(user: User, roomId: string, threadId: string, message: Message): Promise<{ runId: string; started: boolean }> {
  const db = docClient();
  const TableName = tableName();
  const runs = runsRepo();
  const threads = threadsRepo();
  const thread = await threads.threadById(roomId, threadId);
  if (!thread) throw new NotFound("Thread not found.");
  const key = { pk: `ROOM#${roomId}`, sk: threadSk(thread.number) };
  const now = new Date();
  const startedAt = now.toISOString();
  const run: Run = {
    runId: randomUUID(), roomId, threadId, number: thread.number, status: "running", model: "fake", startedBy: user.username,
    startedAt, firstSeq: message.seq, seenSeq: message.seq, steps: 0, costMicros: 0,
  };
  const start = setFields({
    activeRunId: run.runId, runId: run.runId, runFirstSeq: message.seq, status: "running", startedAt, steps: 0, costMicros: 0,
    lastActivityAt: startedAt,
  });

  const claim = new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName, Item: { pk: `RUN#${run.runId}`, sk: "META", ...run }, ConditionExpression: "attribute_not_exists(pk)" } },
      {
        Update: {
          TableName, Key: key, UpdateExpression: `${start.UpdateExpression} REMOVE endedAt, currentStep ADD #rev :one`,
          ConditionExpression: "attribute_not_exists(activeRunId) OR #startedAt < :deadAt",
          ExpressionAttributeNames: { ...start.ExpressionAttributeNames, "#rev": "rev" },
          ExpressionAttributeValues: {
            ...start.ExpressionAttributeValues, ":one": 1, ":deadAt": new Date(now.getTime() - DEAD_AFTER_MS).toISOString(),
          },
        },
      },
    ],
  });
  if (!await claimed(claim)) {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName, Key: key, UpdateExpression: "SET lastActivityAt = :now ADD #rev :one", ExpressionAttributeNames: { "#rev": "rev" },
      ExpressionAttributeValues: { ":now": startedAt, ":one": 1 }, ReturnValues: "ALL_NEW",
    }));
    // The run may have closed since the start failed; then it closed after reading this message, as its last steer.
    const runId = String(Attributes!.activeRunId ?? Attributes!.runId ?? "");
    await notifyRun(roomId, summary(Attributes!, Date.now()), await runs.lastEventSeq(runId));
    return { runId, started: false };
  }

  let first: RunEvent;
  try {
    first = await (await runs.eventWriter(run.runId)).append({ type: "run.started", model: run.model, startedBy: run.startedBy });
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
