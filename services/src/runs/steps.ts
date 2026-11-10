import { budgetRepo } from "../budget/repo.js";
import { gateway } from "../models/index.js";
import { NAME_PROMPT, type ModelChunk, type ToolCall } from "../models/gateway.js";
import { isNumberedName } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus, RunEvent } from "../threads/types.js";
import { buildContext } from "./context.js";
import { endReason, stoppedBy } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { FAKE_TOOLS, runTool, toolDetail } from "./tools.js";

/*
 * The bodies of the run loop's durable steps. A step that fails is run again with the same input, so each one reads
 * the event log it already wrote and skips what an earlier attempt logged.
 */

const SYSTEM = "You are the agent in a team chat thread. Use the tools when they help, then answer the thread.";
const FLUSH_MS = 250;
const STOP_POLL_MS = 1000;
/** Long enough for a send that has taken its seq to finish writing its message. */
const HOLE_WAIT_MS = 1000;

type End = { status: RunEndStatus; reason: string };
type Writer = Awaited<ReturnType<ReturnType<typeof runsRepo>["eventWriter"]>>;
type Usage = Extract<ModelChunk, { type: "usage" }>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/**
 * Every model call is metered: an event for the run's viewers, the room's monthly spend and the run's total, which the
 * room hears at once, so cost and budget move while a long answer streams.
 */
async function recordUsage(run: Run, writer: Writer, usage: Usage): Promise<number> {
  const { inputTokens, outputTokens, costMicros } = usage;
  const event = await writer.append({ type: "usage", model: run.model, inputTokens, outputTokens, costMicros });
  await budgetRepo().record(run.roomId, costMicros, new Date());
  const total = run.costMicros + costMicros;
  await notifyRun(run.roomId, await runsRepo().progress(run, { costMicros: total }), event.seq);
  return total;
}

/** Asks the model for a name for the thread from its first message. Returns the run's cost so far. */
export async function nameThread(run: Run): Promise<number> {
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
 * One model call. First the limits, then the messages members sent since the run last looked, which become steers.
 * The answer streams into the event log in 250 ms batches, and a stop requested meanwhile aborts the call within a
 * second, keeping what was written.
 */
export async function modelTurn(run: Run): Promise<Turn> {
  const end = await limitsReached(run);
  if (end) return { toolCalls: [], seenSeq: run.seenSeq, costMicros: run.costMicros, end };

  const runs = runsRepo();
  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const steered = Math.max(0, ...events.map((e) => (e.type === "steer" ? e.messageSeq : 0)));
  let seenSeq = run.seenSeq;
  const readSteers = async () => {
    for (const m of await runs.unread(run.threadId, seenSeq)) {
      if (m.seq > steered) events.push(await writer.append({ type: "steer", messageSeq: m.seq, authorName: m.authorName, text: m.text }));
      seenSeq = m.seq;
    }
  };
  await readSteers();
  // A seq with no message is a send still writing it, or one that died after taking the number; the second kind never
  // fills, and the close (which needs the counter to equal the cursor) would fail on it forever.
  const lastSeq = await runs.chatLastSeq(run.threadId);
  if (lastSeq > seenSeq) {
    await sleep(HOLE_WAIT_MS);
    await readSteers();
    seenSeq = Math.max(seenSeq, lastSeq);
  }
  const prior = await runs.prior(run.threadId, run.firstSeq);
  return { ...await stream(run, writer, buildContext(prior, events), events), seenSeq };
}

async function stream(run: Run, writer: Writer, messages: ReturnType<typeof buildContext>, events: RunEvent[]) {
  const runs = runsRepo();
  const abort = new AbortController();
  let stopper: string | undefined;
  let failure: unknown;
  let pending = "";
  // Each turn's text after the first starts a new paragraph, in the log itself, so the stored answer and the streamed
  // one stay the same text.
  let lead = events.some((e) => e.type === "text") ? "\n\n" : "";
  const flush = async () => {
    if (!pending) return;
    const text = lead + pending;
    lead = "";
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
    const chunks = gateway().stream({ model: run.model, system: SYSTEM, messages, tools: FAKE_TOOLS, signal: abort.signal });
    for await (const chunk of chunks) {
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
  if (stopper) return { toolCalls: [], costMicros, end: stoppedBy(stopper) };
  return { toolCalls, costMicros };
}

/** One tool call: one step. The limits are checked first, so a stop never waits for another tool. */
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
  const thread = await runs.progress(run, { steps: step, currentStep: call.name });
  await notifyRun(run.roomId, thread, started.seq);
  const t0 = Date.now();
  const { output, ok } = await runTool(call, { sleep });
  const finished = await writer.append({ type: "step.finished", step, output, ms: Date.now() - t0, ok });
  await notifyRun(run.roomId, thread, finished.seq);
  return { steps: step };
}
