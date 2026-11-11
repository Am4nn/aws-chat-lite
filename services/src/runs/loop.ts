import {
  CallbackTimeoutError, createRetryStrategy, DurableOperationError, withDurableExecution, type DurableContext,
} from "@aws/durable-execution-sdk-js";
import type { Approval } from "../approvals/repo.js";
import type { ToolCall } from "../models/gateway.js";
import type { TaintSource } from "../models/privacy.js";
import { gateOf, requestApproval, settleApproval } from "./approval.js";
import { finishRun } from "./finish.js";
import { finishHelper, startHelper } from "./helpers.js";
import { failRun, laneName, load, modelTurn, nameThread, routeRun, toolStep, type End, type RoutedRun, type StepResult } from "./steps.js";
import { DELEGATE } from "./tools.js";

/** Each step is tried 3 times in all, a second or two apart, before the run gives up on it. */
const retryStrategy = createRetryStrategy({ maxAttempts: 3, initialDelay: { seconds: 1 } });
/** The wait outlasts the approval a little, so a decision made just before it expires still wakes the run. */
const WAIT_MARGIN_SEC = 5;

/** What a lane does once its agent is done: the main lane closes the run, which comes back "unread" to carry on. */
type Close = (run: RoutedRun, end: End, force: boolean, turn: number) => Promise<string>;

/** A durable step of a lane; a helper's step names carry its lane. */
const laneStep = (ctx: DurableContext, run: RoutedRun) =>
  <T>(name: string, fn: () => Promise<T>) => ctx.step(laneName(run, name), fn, { retryStrategy });

/**
 * A helper's work runs in a child context of the run's execution: its steps are checkpointed under it, and once it
 * ends its ending is, so a replay returns that without going through its steps. The ending is a few fields, well under
 * the checkpoint's size limit, past which the child would run again on every replay. A helper's step names carry its
 * lane, so on an engine that can't replay child contexts its steps can run in `ctx` itself (`fn(ctx)`) unchanged.
 */
const helperContext = (ctx: DurableContext, name: string, fn: (child: DurableContext) => Promise<End>) =>
  ctx.runInChildContext(name, fn);

/**
 * The agent loop, as one durable execution. Each model call and each tool call is a checkpointed step, so after a
 * crash or a timeout the execution replays finished steps from their results and carries on where it stopped. The
 * loop's own state (cursor, steps, cost) is rebuilt from those results, which is why every step returns it.
 *
 * A write, or a web call in a thread with private content, first waits on a durable callback for a member's decision. The execution is suspended meanwhile, so
 * the wait costs no compute; a decision, a stop or the timeout wakes it, and the approval item says which.
 */
export async function runLoop({ runId }: { runId: string }, ctx: DurableContext): Promise<void> {
  const step = <T>(name: string, fn: () => Promise<T>) => ctx.step(name, fn, { retryStrategy });
  try {
    const loaded = await step("load", () => load(runId));
    if (!loaded) return;
    let run: RoutedRun = { ...loaded.run, agent: loaded.agent, others: loaded.others, ...await step("route", () => routeRun(loaded.run)) };
    if (loaded.provisional) run = { ...run, costMicros: await step("name", () => nameThread(run)) };
    await agentLoop(run, ctx, (r, end, force, i) => step(`close-${i}`, () => finishRun(r, end, { seenSeq: r.seenSeq, force })));
  } catch (e) {
    // A step or an approval's request that failed every try.
    if (!(e instanceof DurableOperationError)) throw e;
    // The stored run carries what was recorded so far, even when the failing step was the first.
    await step("fail", () => failRun(runId));
  }
}

/** One lane's agent at work: model turns and the tools they call, until it answers or the run has to end. */
async function agentLoop(start: RoutedRun, ctx: DurableContext, close: Close): Promise<End> {
  const step = laneStep(ctx, start);
  let run = start;
  for (let i = 1; ; i++) {
    const turn = await step(`model-${i}`, () => modelTurn(run, i));
    run = { ...run, seenSeq: turn.seenSeq, costMicros: turn.costMicros };
    if (turn.end) {
      await close(run, turn.end, true, i);
      return turn.end;
    }
    if (!turn.toolCalls.length) {
      const done = { status: "done" as const };
      // "unread": a message landed after this turn read the thread, so the next turn answers it too.
      if (await close(run, done, false, i) !== "unread") return done;
      continue;
    }
    for (const call of turn.toolCalls) {
      const result = run.others.length > 0 && call.name === DELEGATE
        ? await delegate(run, call, i, ctx)
        : await toolCall(run, call, i, turn.taint ?? [], ctx);
      run = { ...run, steps: result.steps, costMicros: result.costMicros };
      if (result.end) {
        await close(run, result.end, true, i);
        return result.end;
      }
    }
  }
}

/** A tool call, which first waits for a member's decision when its gate asks for one. */
async function toolCall(run: RoutedRun, call: ToolCall, i: number, taint: TaintSource[], ctx: DurableContext): Promise<StepResult> {
  const step = laneStep(ctx, run);
  const gate = await step(`gate-${i}-${call.id}`, () => gateOf(run, call, taint));
  let settled: Approval | undefined;
  if (gate.asks) {
    const n = run.steps + 1;
    try {
      const ask = (callbackId: string) => requestApproval(run, call, n, gate, callbackId);
      await ctx.waitForCallback(laneName(run, `approval-${i}-${call.id}`), ask, {
        timeout: { hours: 0, seconds: gate.timeoutSec + WAIT_MARGIN_SEC }, retryStrategy,
      });
    } catch (e) {
      if (!(e instanceof CallbackTimeoutError)) throw e;
    }
    settled = await step(`settle-${i}-${call.id}`, () => settleApproval(run, n));
  }
  // An approved call runs, and is logged, as the approval stored it: with its repo pinned.
  return step(`tool-${i}-${call.id}`, () => toolStep(run, settled?.call ?? call, settled, undefined, taint));
}

/**
 * A `delegate` call: the helper's own loop, in its lane, between the delegate step's start and its end. Its answer
 * closes nothing: it goes back to this lane as the step's result. A helper whose child context failed (one of its
 * steps failed every try) reads as an error to the agent that delegated, and the run goes on.
 */
async function delegate(run: RoutedRun, call: ToolCall, i: number, ctx: DurableContext): Promise<StepResult> {
  const step = laneStep(ctx, run);
  const handover = await step(`delegate-${i}-${call.id}`, () => startHelper(run, call));
  if ("result" in handover) return handover.result;
  const { helper } = handover;
  let end: End | undefined;
  try {
    end = await helperContext(ctx, `helper-${i}-${call.id}`, (child) => agentLoop(helper, child, async () => "answered"));
  } catch (e) {
    if (!(e instanceof DurableOperationError)) throw e;
  }
  return step(`delegate-end-${i}-${call.id}`, () => finishHelper(helper, end));
}

export const handler = withDurableExecution(runLoop);
