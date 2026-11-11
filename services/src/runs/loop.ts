import {
  CallbackTimeoutError, createRetryStrategy, DurableOperationError, withDurableExecution, type DurableContext,
} from "@aws/durable-execution-sdk-js";
import type { Approval } from "../approvals/repo.js";
import type { RunEndStatus } from "../threads/types.js";
import { gateOf, requestApproval, settleApproval } from "./approval.js";
import { finishRun } from "./finish.js";
import { failRun, load, modelTurn, nameThread, routeRun, toolStep } from "./steps.js";

/** Each step is tried 3 times in all, a second or two apart, before the run gives up on it. */
const retryStrategy = createRetryStrategy({ maxAttempts: 3, initialDelay: { seconds: 1 } });
/** The wait outlasts the approval a little, so a decision made just before it expires still wakes the run. */
const WAIT_MARGIN_SEC = 5;

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
    let run = { ...loaded.run, ...await step("route", () => routeRun(loaded.run)) };
    const close = (name: string, end: { status: RunEndStatus; reason?: string }, force: boolean) =>
      step(name, () => finishRun(run, end, { seenSeq: run.seenSeq, force }));

    if (loaded.provisional) run = { ...run, costMicros: await step("name", () => nameThread(run)) };
    for (let i = 1; ; i++) {
      const turn = await step(`model-${i}`, () => modelTurn(run, i));
      run = { ...run, seenSeq: turn.seenSeq, costMicros: turn.costMicros };
      if (turn.end) {
        await close(`close-${i}`, turn.end, true);
        return;
      }
      if (!turn.toolCalls.length) {
        // "unread": a message landed after this turn read the thread, so the next turn answers it too.
        if (await close(`close-${i}`, { status: "done" }, false) !== "unread") return;
        continue;
      }
      for (const call of turn.toolCalls) {
        const gate = await step(`gate-${i}-${call.id}`, () => gateOf(run, call, turn.taint ?? []));
        let settled: Approval | undefined;
        if (gate.asks) {
          const n = run.steps + 1;
          try {
            const ask = (callbackId: string) => requestApproval(run, call, n, gate, callbackId);
            await ctx.waitForCallback(`approval-${i}-${call.id}`, ask, {
              timeout: { hours: 0, seconds: gate.timeoutSec + WAIT_MARGIN_SEC }, retryStrategy,
            });
          } catch (e) {
            if (!(e instanceof CallbackTimeoutError)) throw e;
          }
          settled = await step(`settle-${i}-${call.id}`, () => settleApproval(run, n));
        }
        // An approved call runs, and is logged, as the approval stored it: with its repo pinned.
        const result = await step(`tool-${i}-${call.id}`, () => toolStep(run, settled?.call ?? call, settled));
        run = { ...run, steps: result.steps, costMicros: result.costMicros };
        if (result.end) {
          await close(`close-${i}`, result.end, true);
          return;
        }
      }
    }
  } catch (e) {
    // A step or an approval's request that failed every try.
    if (!(e instanceof DurableOperationError)) throw e;
    // The stored run carries what was recorded so far, even when the failing step was the first.
    await step("fail", () => failRun(runId));
  }
}

export const handler = withDurableExecution(runLoop);
