import { budgetRepo } from "../budget/repo.js";
import { JOBS, NAMING_MODEL, ROUTER_MODEL } from "../models/catalog.js";
import { gateway } from "../models/index.js";
import { NAME_PROMPT, type ModelChunk, type ModelRequest, type ToolCall } from "../models/gateway.js";
import { modelIdOf, parseRoute, ROUTER_PROMPT, routerInput } from "../models/picks.js";
import { mergeTaint, messageTaint, runRefusal } from "../models/privacy.js";
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
const LENGTH_NOTE = "\n\n(The answer was cut off at the length limit.)";
const REFUSED = "The model declined this request. Try another model.";
const DROPPED = "The model's connection dropped mid-answer.";

type End = { status: RunEndStatus; reason?: string };
type Writer = Awaited<ReturnType<ReturnType<typeof runsRepo>["eventWriter"]>>;
type Usage = Extract<ModelChunk, { type: "usage" }>;
/** A run once its model is settled. */
type RoutedRun = Run & { model: string };

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

const budgetLeft = async (run: Run) => {
  const budget = await budgetRepo().get(run.roomId, new Date());
  return budget.spentMicros < budget.capMicros;
};

/**
 * Every model call is metered: an event for the run's viewers, the room's monthly spend and the run's total, which the
 * room hears at once, so cost and budget move while a long answer streams.
 */
async function recordUsage(run: Run, writer: Writer, usage: Usage, model: string, job: "route" | "name" | "run"): Promise<number> {
  const runs = runsRepo();
  const event = await writer.append({ ...usage, model, job });
  await budgetRepo().record(run.roomId, usage.costMicros, new Date());
  // The stored total, not the step's input: a retried step's input predates the calls an earlier attempt billed.
  const total = ((await runs.getRun(run.runId))?.costMicros ?? run.costMicros) + usage.costMicros;
  await notifyRun(run.roomId, await runs.progress(run, { costMicros: total }), event.seq);
  return total;
}

type Call = { text: string; toolCalls: ToolCall[]; usage?: Usage; end?: Extract<ModelChunk, { type: "end" }>; failed: boolean; error?: unknown };

/** One model call, read to its end. A call that throws comes back failed, with what arrived first, its usage included. */
async function callModel(request: ModelRequest, onText?: (text: string) => void): Promise<Call> {
  const call: Call = { text: "", toolCalls: [], failed: false };
  try {
    for await (const chunk of gateway().stream(request)) {
      if (chunk.type === "text") {
        call.text += chunk.text;
        onText?.(chunk.text);
      } else if (chunk.type === "tool_call") call.toolCalls.push(chunk.call);
      else if (chunk.type === "usage") call.usage = chunk;
      else call.end = chunk;
    }
  } catch (error) {
    call.failed = true;
    call.error = error;
  }
  return call;
}

/**
 * A pick names its model. Auto asks the router on Haiku to choose Haiku or Sonnet from the run's first message, and
 * takes Sonnet without asking once the budget is spent, or when the router fails or declines.
 */
async function chooseModel(run: Run, writer: Writer): Promise<{ model: string; by: "pick" | "default" | "auto"; costMicros: number }> {
  if (run.pick !== "auto") return { model: modelIdOf(run.pick), by: run.pickBy, costMicros: run.costMicros };
  const sonnet = modelIdOf("sonnet");
  if (!await budgetLeft(run)) return { model: sonnet, by: "auto", costMicros: run.costMicros };
  const first = (await runsRepo().prior(run.threadId, run.firstSeq)).at(-1);
  const call = await callModel({
    model: ROUTER_MODEL, system: ROUTER_PROMPT, tools: [], ...JOBS.route,
    messages: [{ role: "user", author: first?.authorName ?? "", text: routerInput(first?.text ?? "") }],
  });
  const costMicros = call.usage ? await recordUsage(run, writer, call.usage, ROUTER_MODEL, "route") : run.costMicros;
  return { model: call.failed || call.end?.stop === "refusal" ? sonnet : parseRoute(call.text), by: "auto", costMicros };
}

/**
 * Settles the model the run answers on before its first model call. A retried step that finds the `routed` event
 * keeps that choice instead of asking the router again.
 */
export async function routeRun(run: Run): Promise<{ model: string; costMicros: number }> {
  const runs = runsRepo();
  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const logged = events.find((e) => e.type === "routed");
  if (logged?.type === "routed") {
    await runs.setModel(run.runId, logged.model);
    return { model: logged.model, costMicros: (await runs.getRun(run.runId))?.costMicros ?? run.costMicros };
  }
  const choice = await chooseModel(run, writer);
  const routed = await writer.append({ type: "routed", model: choice.model, by: choice.by });
  await runs.setModel(run.runId, choice.model);
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  if (thread) await notifyRun(run.roomId, thread, routed.seq);
  return { model: choice.model, costMicros: choice.costMicros };
}

/** Asks the model for a name for the thread from its first message. Returns the run's cost so far. */
export async function nameThread(run: Run): Promise<number> {
  if (!await budgetLeft(run)) return run.costMicros;
  const runs = runsRepo();
  const messages = buildContext(await runs.prior(run.threadId, run.firstSeq), []);
  const call = await callModel({ model: NAMING_MODEL, system: NAME_PROMPT, messages, tools: [], ...JOBS.name });
  const cost = call.usage ? await recordUsage(run, await runs.eventWriter(run.runId), call.usage, NAMING_MODEL, "name") : run.costMicros;
  if (call.failed) throw call.error;
  await threadsRepo().nameIfProvisional(run.roomId, run.threadId, call.text.trim());
  return cost;
}

type Turn = { toolCalls: ToolCall[]; seenSeq: number; costMicros: number; end?: End };

/**
 * One model call. First the limits, then the messages members sent since the run last looked, which become steers,
 * then the privacy gate. The answer streams into the event log in 250 ms batches, and a stop requested meanwhile
 * aborts the call within a second, keeping what was written.
 */
export async function modelTurn(run: RoutedRun): Promise<Turn> {
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
  const [prior, steers, thread] = await Promise.all([
    runs.prior(run.threadId, run.firstSeq), runs.unread(run.threadId, run.firstSeq), threadsRepo().threadById(run.roomId, run.threadId),
  ]);
  // The thread's taint is written after a send is acknowledged, so it can lag behind a file that just landed; the
  // messages this call would carry, the thread and every steer, are checked themselves.
  const taint = mergeTaint(thread?.taint ?? [], ...[...prior, ...steers].map(messageTaint));
  const refused = runRefusal(run.model, taint);
  if (refused) return { toolCalls: [], seenSeq, costMicros: run.costMicros, end: refused };
  return { ...await stream(run, writer, buildContext(prior, events), events), seenSeq };
}

async function stream(run: RoutedRun, writer: Writer, messages: ReturnType<typeof buildContext>, events: RunEvent[]) {
  const runs = runsRepo();
  const abort = new AbortController();
  let stopper: string | undefined;
  let failure: unknown;
  let pending = "";
  let wrote = false;
  // Each turn's text after the first starts a new paragraph, in the log itself, so the stored answer and the streamed
  // one stay the same text.
  let lead = events.some((e) => e.type === "text") ? "\n\n" : "";
  const flush = async () => {
    if (!pending) return;
    const text = lead + pending;
    lead = "";
    pending = "";
    await writer.append({ type: "text", text });
    wrote = true;
  };
  const flusher = setInterval(() => flush().catch((e) => { failure ??= e; abort.abort(); }), FLUSH_MS);
  const poller = setInterval(() => {
    runs.getRun(run.runId).then((r) => {
      if (r?.stopRequestedBy) { stopper = r.stopRequestedBy; abort.abort(); }
    }, (e) => console.error("stop poll failed", run.runId, e));
  }, STOP_POLL_MS);

  // Real models get no tools yet, and the fake's tool names are ones only the fake accepts.
  const tools = gateway().servedBy(run.model) === "fake" ? FAKE_TOOLS : [];
  let call: Call;
  try {
    call = await callModel(
      { model: run.model, system: SYSTEM, messages, tools, ...JOBS.run, signal: abort.signal }, (text) => { pending += text; },
    );
  } finally {
    clearInterval(flusher);
    clearInterval(poller);
  }
  await flush();
  if (call.end?.native) await writer.append({ type: "model.turn", ...call.end.native });
  // Billed before anything is rethrown: a call that dropped was still sent its input.
  const costMicros = call.usage ? await recordUsage(run, writer, call.usage, run.model, "run") : run.costMicros;
  if (failure) throw failure;
  const ending = (end: End) => ({ toolCalls: [], costMicros, end });
  // A model may reject its stream once aborted; a stop is not an error.
  if (stopper) return ending(stoppedBy(stopper));
  if (call.failed) {
    // A retry would log this attempt's text a second time, so only a call that showed nothing is tried again.
    if (!wrote) throw call.error;
    return ending({ status: "failed", reason: DROPPED });
  }
  if (call.end?.stop === "refusal") return ending({ status: "failed", reason: REFUSED });
  if (call.end?.stop === "max_tokens") {
    // The tool calls of a cut-off turn may be cut off too, so none of them runs.
    await writer.append({ type: "text", text: LENGTH_NOTE });
    return ending({ status: "done" });
  }
  return { toolCalls: call.toolCalls, costMicros };
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
