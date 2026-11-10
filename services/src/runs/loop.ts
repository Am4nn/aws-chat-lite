import { createRetryStrategy, StepError, withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import { budgetRepo } from "../budget/repo.js";
import { gateway } from "../models/index.js";
import { NAME_PROMPT, type ModelChunk, type ToolCall } from "../models/gateway.js";
import { isNumberedName } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus } from "../threads/types.js";
import { buildContext } from "./context.js";
import { finishRun } from "./finish.js";
import { endReason, stoppedBy } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { FAKE_TOOLS, runTool, toolDetail } from "./tools.js";

const SYSTEM = "You are the agent in a team chat thread. Use the tools when they help, then answer the thread.";
const FLUSH_MS = 250;
const STOP_POLL_MS = 1000;
/** Each step is tried 3 times in all, a second or two apart, before the run gives up on it. */
const retryStrategy = createRetryStrategy({ maxAttempts: 3, initialDelay: { seconds: 1 } });

type End = { status: RunEndStatus; reason: string };
type Writer = Awaited<ReturnType<ReturnType<typeof runsRepo>["eventWriter"]>>;
type Usage = Extract<ModelChunk, { type: "usage" }>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Null when the run is already over (its start failed after the invoke was accepted). */
async function load(runId: string): Promise<{ run: Run; provisional: boolean } | null> {
  const run = await runsRepo().getRun(runId);
  if (run?.status !== "running") return null;
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  // Only a thread's first run names it, and only while nobody has.
  return { run, provisional: run.firstSeq === 1 && !!thread && isNumberedName(thread.name) };
}

/** Every model call is metered: an event for the run's viewers, the room's monthly spend, and the run's total. */
async function recordUsage(run: Run, writer: Writer, usage: Usage): Promise<number> {
  const { inputTokens, outputTokens, costMicros } = usage;
  await writer.append({ type: "usage", model: run.model, inputTokens, outputTokens, costMicros });
  await budgetRepo().record(run.roomId, costMicros, new Date());
  const total = run.costMicros + costMicros;
  await runsRepo().progress(run, { costMicros: total });
  return total;
}

/** Asks the model for a name for the thread from its first message. Returns the run's cost so far. */
async function nameThread(run: Run): Promise<number> {
  const budget = await budgetRepo().get(run.roomId, new Date());
  if (budget.spentMicros >= budget.capMicros) return run.costMicros;
  const runs = runsRepo();
  const messages = buildContext(await runs.prior(run.threadId, run.firstSeq), []);
  let name = "";
  let usage: Usage | undefined;
  for await (const chunk of gateway().stream({ model: run.model, system: NAME_PROMPT, messages, tools: [] })) {
    if (chunk.type === "text") name += chunk.text;
    else if (chunk.type === "usage") usage = chunk;
  }
  const cost = usage ? await recordUsage(run, await runs.eventWriter(run.runId), usage) : run.costMicros;
  await threadsRepo().nameIfProvisional(run.roomId, run.threadId, name.trim());
  return cost;
}

type Turn = { toolCalls: ToolCall[]; seenSeq: number; costMicros: number; end?: End };

/**
 * One model call. First the limits (stop, budget, steps, time), then the messages members sent since the run last
 * looked, which become steers. The answer streams into the event log in 250 ms batches, and a stop requested
 * meanwhile aborts the call within a second, keeping what was written.
 */
async function modelTurn(run: Run): Promise<Turn> {
  const runs = runsRepo();
  const [current, budget] = await Promise.all([runs.getRun(run.runId), budgetRepo().get(run.roomId, new Date())]);
  const limits = {
    stopRequestedBy: current?.stopRequestedBy, steps: run.steps, startedAtMs: Date.parse(run.startedAt),
    spentMicros: budget.spentMicros, capMicros: budget.capMicros, month: budget.month,
  };
  const end = endReason(limits, Date.now());
  if (end) return { toolCalls: [], seenSeq: run.seenSeq, costMicros: run.costMicros, end };

  const writer = await runs.eventWriter(run.runId);
  let seenSeq = run.seenSeq;
  for (const m of await runs.unread(run.threadId, seenSeq)) {
    await writer.append({ type: "steer", messageSeq: m.seq, authorName: m.authorName, text: m.text });
    seenSeq = m.seq;
  }
  const [prior, events] = await Promise.all([runs.prior(run.threadId, run.firstSeq), runs.allEvents(run.runId)]);

  const abort = new AbortController();
  let stopper: string | undefined;
  let failure: unknown;
  let pending = "";
  const flush = async () => {
    if (!pending) return;
    const text = pending;
    pending = "";
    await writer.append({ type: "text", text });
  };
  const flusher = setInterval(() => flush().catch((e) => { failure ??= e; abort.abort(); }), FLUSH_MS);
  const poller = setInterval(() => {
    runs.getRun(run.runId).then((r) => {
      if (r?.stopRequestedBy) { stopper = r.stopRequestedBy; abort.abort(); }
    }, (e) => console.error("stop poll failed", run.runId, e));
  }, STOP_POLL_MS);

  const toolCalls: ToolCall[] = [];
  let usage: Usage | undefined;
  try {
    const stream = gateway().stream({
      model: run.model, system: SYSTEM, messages: buildContext(prior, events), tools: FAKE_TOOLS, signal: abort.signal,
    });
    for await (const chunk of stream) {
      if (chunk.type === "text") pending += chunk.text;
      else if (chunk.type === "tool_call") toolCalls.push(chunk.call);
      else usage = chunk;
    }
  } catch (e) {
    // A model may reject its stream once aborted; a stop is not an error.
    if (!stopper) throw e;
  } finally {
    clearInterval(flusher);
    clearInterval(poller);
  }
  await flush();
  if (failure) throw failure;
  const costMicros = usage ? await recordUsage(run, writer, usage) : run.costMicros;
  if (stopper) return { toolCalls: [], seenSeq, costMicros, end: stoppedBy(stopper) };
  return { toolCalls, seenSeq, costMicros };
}

/** One tool call: one step. The stop flag is checked first, so a stop never waits for another tool. */
async function toolStep(run: Run, call: ToolCall): Promise<{ steps: number; end?: End }> {
  const runs = runsRepo();
  const current = await runs.getRun(run.runId);
  if (current?.stopRequestedBy) return { steps: run.steps, end: stoppedBy(current.stopRequestedBy) };

  const step = run.steps + 1;
  const writer = await runs.eventWriter(run.runId);
  const started = await writer.append({ type: "step.started", step, call, detail: toolDetail(call) });
  const thread = await runs.progress(run, { steps: step, currentStep: call.name });
  await notifyRun(run.roomId, thread, started.seq);
  const t0 = Date.now();
  const { output, ok } = await runTool(call, { sleep });
  const finished = await writer.append({ type: "step.finished", step, output, ms: Date.now() - t0, ok });
  await notifyRun(run.roomId, thread, finished.seq);
  return { steps: step };
}

/**
 * The agent loop, as one durable execution. Each model call and each tool call is a checkpointed step, so after a
 * crash or a timeout the execution replays finished steps from their results and carries on where it stopped. The
 * loop's own state (cursor, steps, cost) is rebuilt from those results, which is why every step returns it.
 */
export async function runLoop({ runId }: { runId: string }, ctx: DurableContext): Promise<void> {
  const step = <T>(name: string, fn: () => Promise<T>) => ctx.step(name, fn, { retryStrategy });
  const loaded = await step("load", () => load(runId));
  if (!loaded) return;
  let run = loaded.run;
  const close = (name: string, end: { status: RunEndStatus; reason?: string }, force: boolean) =>
    step(name, () => finishRun(run, end, { seenSeq: run.seenSeq, force }));

  try {
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
    await close("fail", { status: "failed", reason: "The agent hit an error." }, true);
  }
}

export const handler = withDurableExecution(runLoop);
