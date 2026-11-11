import { budgetRepo } from "../budget/repo.js";
import { sleep } from "../lib/sleep.js";
import { gateway } from "../models/index.js";
import { NAME_PROMPT, type ModelChunk, type ToolCall } from "../models/gateway.js";
import { isNumberedName } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus, RunEvent } from "../threads/types.js";
import { answerOf, buildContext } from "./context.js";
import { endReason, stoppedBy } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { FAKE_TOOLS, runTool, toolDetail } from "./tools.js";

/*
 * The bodies of the run loop's durable steps. A step that fails is run again with the same input, so each one reads
 * what an earlier attempt wrote and skips it: logged steers and tool steps, and model calls already recorded.
 */

const SYSTEM = "You are the agent in a team chat thread. Use the tools when they help, then answer the thread.";
const FLUSH_MS = 250;
const STOP_POLL_MS = 1000;
/** Long enough for a send that has taken its seq to finish writing its message. */
const HOLE_WAIT_MS = 1000;
/** One call's output is capped, so a single answer can't spend much of a room's budget on its own. */
const MAX_TOKENS = 4096;

type End = { status: RunEndStatus; reason: string };
type Writer = Awaited<ReturnType<ReturnType<typeof runsRepo>["eventWriter"]>>;
type Usage = Extract<ModelChunk, { type: "usage" }>;

/** Null when the run is already over (its start failed after the invoke was accepted). */
export async function load(runId: string): Promise<{ run: Run; provisional: boolean } | null> {
  const run = await runsRepo().getRun(runId);
  if (run?.status !== "running") return null;
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  // A thread keeps its `thread-<N>` name until someone or a run names it; names like that can't be picked.
  return { run, provisional: !!thread && isNumberedName(thread.name) };
}

/** Stop, budget, steps and time, checked before every model call and every tool call. */
async function limitsReached(run: Run): Promise<End | null> {
  const [current, budget] = await Promise.all([runsRepo().getRun(run.runId), budgetRepo().get(run.roomId, new Date())]);
  return endReason({
    stopRequestedBy: current?.stopRequestedBy, steps: run.steps, startedAtMs: Date.parse(run.startedAt),
    spentMicros: budget.spentMicros, capMicros: budget.capMicros, month: budget.month,
  }, Date.now());
}

/** Polls the run's stop flag every second, and aborts the signal once a member has asked the run to stop. */
function watchStop(runId: string) {
  const abort = new AbortController();
  let by: string | undefined;
  const poller = setInterval(() => {
    runsRepo().getRun(runId).then((r) => {
      if (r?.stopRequestedBy) { by = r.stopRequestedBy; abort.abort(); }
    }, (e) => console.error("stop poll failed", runId, e));
  }, STOP_POLL_MS);
  return { signal: abort.signal, abort: () => abort.abort(), stoppedBy: () => by, close: () => clearInterval(poller) };
}

/**
 * Every model call is metered, once. Its usage event, the room's monthly spend and a marker holding the step's result
 * are one transaction, which the marker refuses to repeat. A retried step looks for the marker first and returns the
 * result it holds, so no call is charged twice or made twice. The room hears the cost at once, so cost and budget
 * move while a long answer streams.
 */
async function recordCall<T extends { costMicros: number }>(run: Run, writer: Writer, call: string, usage: Usage, result: T): Promise<T> {
  const runs = runsRepo();
  const { inputTokens, outputTokens, costMicros } = usage;
  const event = await writer.append({ type: "usage", model: run.model, inputTokens, outputTokens, costMicros }, [
    runs.callMarker(run.runId, call, result), budgetRepo().spend(run.roomId, costMicros, new Date()),
  ]);
  await notifyRun(run.roomId, await runs.progress(run, { costMicros: result.costMicros }), event.seq);
  return result;
}

type Named = { name: string; costMicros: number };

/** Asks the model for a name for the thread from its first message. Returns the run's cost so far. */
export async function nameThread(run: Run): Promise<number> {
  const named = await runsRepo().recorded<Named>(run.runId, "name") ?? await suggestName(run);
  if (named.name) await threadsRepo().nameIfProvisional(run.roomId, run.threadId, named.name);
  return named.costMicros;
}

async function suggestName(run: Run): Promise<Named> {
  const budget = await budgetRepo().get(run.roomId, new Date());
  if (budget.spentMicros >= budget.capMicros) return { name: "", costMicros: run.costMicros };
  const runs = runsRepo();
  const messages = buildContext(await runs.prior(run.threadId, run.firstSeq), []);
  let name = "";
  let usage: Usage | undefined;
  for await (const chunk of gateway().stream({ model: run.model, system: NAME_PROMPT, messages, tools: [], maxTokens: MAX_TOKENS })) {
    if (chunk.type === "text") name += chunk.text;
    else if (chunk.type === "usage") usage = chunk;
  }
  const named = { name: name.trim(), costMicros: run.costMicros + (usage?.costMicros ?? 0) };
  return usage ? recordCall(run, await runs.eventWriter(run.runId), "name", usage, named) : named;
}

const warnHoles = (threadId: string, from: number, to: number) => {
  for (let seq = from; seq <= to; seq++) console.warn("stepping over a thread message that was never written", threadId, seq);
};

/**
 * Reads the messages members sent since the run's cursor as steers, and returns the new cursor. Two sends can store
 * their messages out of seq order, so the cursor only moves over seqs whose message is there; passing a missing one
 * would leave it unanswered. A seq still missing after a second is stepped over: a send that died after taking its
 * number never fills it, and the close (which needs the counter to equal the cursor) would fail on it forever.
 */
async function readSteers(run: Run, events: RunEvent[], writer: Writer): Promise<number> {
  const runs = runsRepo();
  const steered = Math.max(0, ...events.map((e) => (e.type === "steer" ? e.messageSeq : 0)));
  let seenSeq = run.seenSeq;
  const read = async (overHoles: boolean) => {
    for (const m of await runs.unread(run.threadId, seenSeq)) {
      if (m.seq !== seenSeq + 1) {
        if (!overHoles) return;
        warnHoles(run.threadId, seenSeq + 1, m.seq - 1);
      }
      if (m.seq > steered) events.push(await writer.append({ type: "steer", messageSeq: m.seq, authorName: m.authorName, text: m.text }));
      seenSeq = m.seq;
    }
  };
  await read(false);
  const lastSeq = await runs.chatLastSeq(run.threadId);
  if (lastSeq > seenSeq) {
    await sleep(HOLE_WAIT_MS);
    await read(true);
    warnHoles(run.threadId, seenSeq + 1, lastSeq);
    seenSeq = Math.max(seenSeq, lastSeq);
  }
  return seenSeq;
}

type Turn = { toolCalls: ToolCall[]; seenSeq: number; costMicros: number; end?: End };

/**
 * One model call: the loop's `model-<turn>` step. First the limits, then the messages members sent since the run
 * last looked, which become steers. The answer streams into the event log in 250 ms batches, and a stop requested
 * meanwhile aborts the call within a second, keeping what was written. An earlier attempt that wrote text but never
 * recorded its call has its text voided (`text.reset`) before the model answers again.
 */
export async function modelTurn(run: Run, turn: number): Promise<Turn> {
  const runs = runsRepo();
  const call = `model-${turn}`;
  const recorded = await runs.recorded<Turn>(run.runId, call);
  if (recorded) return recorded;
  const end = await limitsReached(run);
  if (end) return { toolCalls: [], seenSeq: run.seenSeq, costMicros: run.costMicros, end };

  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const seenSeq = await readSteers(run, events, writer);
  if (events.some((e) => e.type === "text" && e.turn === turn)) events.push(await writer.append({ type: "text.reset", turn }));
  const prior = await runs.prior(run.threadId, run.firstSeq);
  const { toolCalls, usage, stopper } = await stream(run, writer, buildContext(prior, events), events, turn);
  const result: Turn = {
    toolCalls: stopper ? [] : toolCalls, seenSeq, costMicros: run.costMicros + (usage?.costMicros ?? 0),
    end: stopper ? stoppedBy(stopper) : undefined,
  };
  return usage ? recordCall(run, writer, call, usage, result) : result;
}

async function stream(run: Run, writer: Writer, messages: ReturnType<typeof buildContext>, events: RunEvent[], turn: number) {
  const stop = watchStop(run.runId);
  let failure: unknown;
  let pending = "";
  // Each turn's text after the first starts a new paragraph, in the log itself, so the stored answer and the streamed
  // one stay the same text.
  let lead = answerOf(events).text ? "\n\n" : "";
  const flush = async () => {
    if (!pending) return;
    const text = lead + pending;
    lead = "";
    pending = "";
    await writer.append({ type: "text", text, turn });
  };
  const flusher = setInterval(() => flush().catch((e) => { failure ??= e; stop.abort(); }), FLUSH_MS);

  const toolCalls: ToolCall[] = [];
  let usage: Usage | undefined;
  try {
    const chunks = gateway().stream({
      model: run.model, system: SYSTEM, messages, tools: FAKE_TOOLS, maxTokens: MAX_TOKENS, signal: stop.signal,
    });
    for await (const chunk of chunks) {
      if (chunk.type === "text") pending += chunk.text;
      else if (chunk.type === "tool_call") toolCalls.push(chunk.call);
      else usage = chunk;
    }
  } catch (e) {
    // A model may reject its stream once aborted; a stop is not an error.
    if (!stop.stoppedBy()) throw e;
  } finally {
    clearInterval(flusher);
    stop.close();
  }
  await flush();
  if (failure) throw failure;
  return { toolCalls, usage, stopper: stop.stoppedBy() };
}

/**
 * One tool call: one step. The limits are checked first, so a stop never waits for another tool, and a stop
 * requested while the tool works cuts it short.
 */
export async function toolStep(run: Run, call: ToolCall): Promise<{ steps: number; end?: End }> {
  const end = await limitsReached(run);
  if (end) return { steps: run.steps, end };

  const runs = runsRepo();
  const step = run.steps + 1;
  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const logged = (type: string) => events.find((e) => (e.type === type) && "step" in e && e.step === step);
  // An earlier attempt finished the tool and logged it, and only failed after: its result stands.
  if (logged("step.finished")) return { steps: step };
  const started = logged("step.started") ?? await writer.append({ type: "step.started", step, call, detail: toolDetail(call) });
  await notifyRun(run.roomId, await runs.progress(run, { steps: step, currentStep: call.name }), started.seq);
  const stop = watchStop(run.runId);
  const t0 = Date.now();
  const { output, ok } = await runTool(call, { sleep, signal: stop.signal }).finally(stop.close);
  const finished = await writer.append({ type: "step.finished", step, output, ms: Date.now() - t0, ok });
  await notifyRun(run.roomId, await runs.stepDone(run), finished.seq);
  return { steps: step };
}
