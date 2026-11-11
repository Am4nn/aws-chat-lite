import { createRetryStrategy, StepError, withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import type { RunEndStatus } from "../threads/types.js";
import { finishRun } from "./finish.js";
import { runsRepo } from "./repo.js";
import { load, modelTurn, nameThread, routeRun, toolStep } from "./steps.js";

/** Each step is tried 3 times in all, a second or two apart, before the run gives up on it. */
const retryStrategy = createRetryStrategy({ maxAttempts: 3, initialDelay: { seconds: 1 } });

/**
 * The agent loop, as one durable execution. Each model call and each tool call is a checkpointed step, so after a
 * crash or a timeout the execution replays finished steps from their results and carries on where it stopped. The
 * loop's own state (cursor, steps, cost) is rebuilt from those results, which is why every step returns it.
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
      const turn = await step(`model-${i}`, () => modelTurn(run));
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
        const result = await step(`tool-${i}-${call.id}`, () => toolStep(run, call));
        run = { ...run, steps: result.steps };
        if (result.end) {
          await close(`close-${i}`, result.end, true);
          return;
        }
      }
    }
  } catch (e) {
    if (!(e instanceof StepError)) throw e;
    // The stored run carries the steps and cost recorded so far, even when the failing step was the first.
    await step("fail", async () => {
      const run = await runsRepo().getRun(runId);
      return run ? finishRun(run, { status: "failed", reason: "The agent hit an error." }, { seenSeq: run.seenSeq, force: true }) : null;
    });
  }
}

export const handler = withDurableExecution(runLoop);
