import { budgetRepo } from "../budget/repo.js";
import { sleep } from "../lib/sleep.js";
import { JOBS, NAMING_MODEL, ROUTER_MODEL } from "../models/catalog.js";
import { gateway } from "../models/index.js";
import { NAME_PROMPT, type ModelChunk, type ModelRequest, type ToolCall } from "../models/gateway.js";
import { modelIdOf, parseRoute, ROUTER_PROMPT, routerInput } from "../models/picks.js";
import { mergeTaint, messageTaint, runRefusal } from "../models/privacy.js";
import { isNumberedName } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus, RunEvent } from "../threads/types.js";
import { sandboxCostMicros } from "../workspace/limits.js";
import { runSandbox } from "../workspace/session.js";
import type { FilesSynced } from "../workspace/types.js";
import { answerOf, buildContext } from "./context.js";
import { endReason, stoppedBy } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { runTool, SANDBOX_TOOL, toolDetail, toolsFor } from "./tools.js";

/*
 * The bodies of the run loop's durable steps. A step that fails is run again with the same input, so each one reads
 * what an earlier attempt wrote and skips it: logged steers and tool steps, and model calls already recorded.
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

/** The run's cost so far: the sum of the calls it has recorded, a retried step's earlier attempts included. */
const costOf = (events: RunEvent[]) => events.reduce((sum, e) => sum + (e.type === "usage" ? e.costMicros : 0), 0);

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

/** Which call a usage event bills, and the step whose result that call settles, if it settles one. */
type Meter = { model: string; job: "route" | "name" | "run" | "sandbox"; step?: string };

/**
 * Every model call is metered, once: its usage event and the room's monthly spend are one transaction. A call that
 * settles its step adds a marker holding the step's result, which the transaction refuses to repeat; a retried step
 * looks for the marker first and returns the result it holds, so that call is neither charged nor made twice. A call
 * whose step is about to be retried has no marker: the provider billed it, and the retry is a new call. The room
 * hears the cost at once, so cost and budget move while a long answer streams.
 */
async function recordCall<T extends { costMicros: number }>(run: Run, writer: Writer, meter: Meter, usage: Usage, result: T): Promise<T> {
  const runs = runsRepo();
  const marker = meter.step ? [runs.callMarker(run.runId, meter.step, result)] : [];
  const event = await writer.append({ ...usage, model: meter.model, job: meter.job }, [
    ...marker, budgetRepo().spend(run.roomId, usage.costMicros, new Date()),
  ]);
  await notifyRun(run.roomId, await runs.progress(run, { costMicros: result.costMicros }), event.seq);
  return result;
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

type Choice = { model: string; by: "pick" | "default" | "auto"; costMicros: number };

/**
 * A pick names its model. Auto asks the router on Haiku to choose Haiku or Sonnet from the run's first message, and
 * takes Sonnet without asking once the budget is spent, or when the router fails or declines.
 */
async function chooseModel(run: Run, writer: Writer): Promise<Choice> {
  if (run.pick !== "auto") return { model: modelIdOf(run.pick), by: run.pickBy, costMicros: run.costMicros };
  const sonnet = modelIdOf("sonnet");
  if (!await budgetLeft(run)) return { model: sonnet, by: "auto", costMicros: run.costMicros };
  const first = (await runsRepo().prior(run.threadId, run.firstSeq)).at(-1);
  const call = await callModel({
    model: ROUTER_MODEL, system: ROUTER_PROMPT, tools: [], ...JOBS.route,
    messages: [{ role: "user", author: first?.authorName ?? "", text: routerInput(first?.text ?? "") }],
  });
  const choice: Choice = {
    model: call.failed || call.end?.stop === "refusal" ? sonnet : parseRoute(call.text), by: "auto",
    costMicros: run.costMicros + (call.usage?.costMicros ?? 0),
  };
  return call.usage ? recordCall(run, writer, { model: ROUTER_MODEL, job: "route", step: "route" }, call.usage, choice) : choice;
}

/**
 * Settles the model the run answers on before its first model call. A retried step keeps the router's recorded
 * choice instead of asking again, and logs `routed` once.
 */
export async function routeRun(run: Run): Promise<{ model: string; costMicros: number }> {
  const runs = runsRepo();
  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const choice = await runs.recorded<Choice>(run.runId, "route") ?? await chooseModel(run, writer);
  const logged = events.find((e) => e.type === "routed");
  const routed = logged ?? await writer.append({ type: "routed", model: choice.model, by: choice.by });
  await runs.setModel(run.runId, choice.model);
  if (!logged) {
    const thread = await threadsRepo().threadById(run.roomId, run.threadId);
    if (thread) await notifyRun(run.roomId, thread, routed.seq);
  }
  return { model: choice.model, costMicros: choice.costMicros };
}

type Named = { name: string; costMicros: number };

/** Asks the model for a name for the thread from its first message. Returns the run's cost so far. */
export async function nameThread(run: Run): Promise<number> {
  const named = await runsRepo().recorded<Named>(run.runId, "name") ?? await suggestName(run);
  if (named.name) await threadsRepo().nameIfProvisional(run.roomId, run.threadId, named.name);
  return named.costMicros;
}

async function suggestName(run: Run): Promise<Named> {
  if (!await budgetLeft(run)) return { name: "", costMicros: run.costMicros };
  const runs = runsRepo();
  const messages = buildContext(await runs.prior(run.threadId, run.firstSeq), []);
  const call = await callModel({ model: NAMING_MODEL, system: NAME_PROMPT, messages, tools: [], ...JOBS.name });
  // A name is a nicety: a failed call keeps the numbered name, which anyone can still change, and the run goes on.
  const named = { name: call.failed ? "" : call.text.trim(), costMicros: run.costMicros + (call.usage?.costMicros ?? 0) };
  if (!call.usage) return named;
  return recordCall(run, await runs.eventWriter(run.runId), { model: NAMING_MODEL, job: "name", step: "name" }, call.usage, named);
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
 * last looked, which become steers, then the privacy gate. The answer streams into the event log in 250 ms batches,
 * and a stop requested meanwhile aborts the call within a second, keeping what was written. What an earlier attempt
 * wrote for this turn without recording its call (its text and native turn) is voided by a `text.reset` before the
 * model answers again.
 */
export async function modelTurn(run: RoutedRun, turn: number): Promise<Turn> {
  const runs = runsRepo();
  const recorded = await runs.recorded<Turn>(run.runId, `model-${turn}`);
  if (recorded) return recorded;
  const [events, writer, end] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId), limitsReached(run)]);
  if (end) return { toolCalls: [], seenSeq: run.seenSeq, costMicros: costOf(events), end };

  const seenSeq = await readSteers(run, events, writer);
  const [prior, steers, thread] = await Promise.all([
    runs.prior(run.threadId, run.firstSeq), runs.unread(run.threadId, run.firstSeq), threadsRepo().threadById(run.roomId, run.threadId),
  ]);
  // The thread's taint is written after a send is acknowledged, so it can lag behind a file that just landed; the
  // messages this call would carry, the thread and every steer, are checked themselves.
  const taint = mergeTaint(thread?.taint ?? [], ...[...prior, ...steers].map(messageTaint));
  const refused = runRefusal(run.model, taint);
  if (refused) return { toolCalls: [], seenSeq, costMicros: costOf(events), end: refused };

  if (events.some((e) => (e.type === "text" || e.type === "model.turn") && e.turn === turn)) {
    events.push(await writer.append({ type: "text.reset", turn }));
  }
  return stream(run, writer, buildContext(prior, events), events, { turn, seenSeq });
}

async function stream(
  run: RoutedRun, writer: Writer, messages: ReturnType<typeof buildContext>, events: RunEvent[], at: { turn: number; seenSeq: number },
): Promise<Turn> {
  const { turn, seenSeq } = at;
  const stop = watchStop(run.runId);
  let failure: unknown;
  let pending = "";
  let wrote = false;
  // Each turn's text after the first starts a new paragraph, in the log itself, so the stored answer and the streamed
  // one stay the same text.
  let lead = answerOf(events).text ? "\n\n" : "";
  const flush = async () => {
    if (!pending) return;
    const text = lead + pending;
    lead = "";
    pending = "";
    await writer.append({ type: "text", text, turn });
    wrote = true;
  };
  const flusher = setInterval(() => flush().catch((e) => { failure ??= e; stop.abort(); }), FLUSH_MS);

  const tools = toolsFor(run.model, gateway().servedBy(run.model));
  let call: Call;
  try {
    call = await callModel(
      { model: run.model, system: SYSTEM, messages, tools, ...JOBS.run, signal: stop.signal }, (text) => { pending += text; },
    );
  } finally {
    clearInterval(flusher);
    stop.close();
  }
  await flush().catch((e) => { failure ??= e; });
  const stopper = stop.stoppedBy();
  const spent = costOf(events);
  // A model may reject its stream once aborted; a stop is not an error. A call that dropped before showing anything
  // is tried again, as is one whose text didn't all reach the log; a drop after text ends the run instead, since a
  // fresh answer would replace the one members were already reading.
  if (failure || (call.failed && !wrote && !stopper)) {
    // The provider billed the attempt, dropped or not, so it is charged before the retry.
    if (call.usage) await recordCall(run, writer, { model: run.model, job: "run" }, call.usage, { costMicros: spent + call.usage.costMicros });
    throw failure ?? call.error;
  }
  if (call.end?.native) await writer.append({ type: "model.turn", ...call.end.native, turn });
  const settle = (result: Pick<Turn, "toolCalls" | "end">) => {
    const turnResult = { ...result, seenSeq, costMicros: spent + (call.usage?.costMicros ?? 0) };
    if (!call.usage) return turnResult;
    return recordCall(run, writer, { model: run.model, job: "run", step: `model-${turn}` }, call.usage, turnResult);
  };
  if (stopper) return settle({ toolCalls: [], end: stoppedBy(stopper) });
  if (call.failed) return settle({ toolCalls: [], end: { status: "failed", reason: DROPPED } });
  if (call.end?.stop === "refusal") return settle({ toolCalls: [], end: { status: "failed", reason: REFUSED } });
  if (call.end?.stop === "max_tokens") {
    // The tool calls of a cut-off turn may be cut off too, so none of them runs.
    await writer.append({ type: "text", text: LENGTH_NOTE, turn });
    return settle({ toolCalls: [], end: { status: "done" } });
  }
  return settle({ toolCalls: call.toolCalls });
}

type ToolResult = { steps: number; costMicros: number; end?: End };

/**
 * Sandbox time, billed like a model call so it counts towards the run's cost and the room's budget. Its marker holds
 * the step's result, so a retry that finds the step finished bills it only when no earlier attempt did.
 */
const billSandbox = (run: Run, writer: Writer, events: RunEvent[], step: number, ms: number): Promise<ToolResult> => {
  const usage: Usage = { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: sandboxCostMicros(ms) };
  const result = { steps: step, costMicros: costOf(events) + usage.costMicros };
  return recordCall(run, writer, { model: "sandbox", job: "sandbox", step: `sandbox-${step}` }, usage, result);
};

const hasChanges = (s: FilesSynced) => s.written.length + s.deleted.length + s.notes.length > 0;

/**
 * Only a tool the model was offered runs, so a model kept from private content can't reach the sandbox by naming it.
 * A stop requested while another tool works cuts it short.
 */
async function runCall(run: RoutedRun, call: ToolCall, offered: boolean): Promise<{ output: string; ok: boolean; synced?: FilesSynced }> {
  if (!offered) return { ok: false, output: `Unknown tool ${call.name}.` };
  if (call.name === SANDBOX_TOOL.name) return runSandbox(run, call.input);
  const stop = watchStop(run.runId);
  return runTool(call, { sleep, signal: stop.signal }).finally(stop.close);
}

/**
 * One tool call: one step. The limits are checked first, so a stop never waits for another tool. A sandbox step
 * taints the thread before any code runs, since its output carries room files, and is billed once it has finished.
 */
export async function toolStep(run: RoutedRun, call: ToolCall): Promise<ToolResult> {
  const end = await limitsReached(run);
  if (end) return { steps: run.steps, costMicros: run.costMicros, end };

  const runs = runsRepo();
  const step = run.steps + 1;
  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const logged = (type: string) => events.find((e) => (e.type === type) && "step" in e && e.step === step);
  const offered = toolsFor(run.model, gateway().servedBy(run.model)).some((t) => t.name === call.name);
  const sandboxed = offered && call.name === SANDBOX_TOOL.name;
  // An earlier attempt finished the tool and logged it, and only failed after: its result stands.
  const done = logged("step.finished");
  if (done?.type === "step.finished") {
    if (!sandboxed) return { steps: step, costMicros: run.costMicros };
    return await runs.recorded<ToolResult>(run.runId, `sandbox-${step}`) ?? billSandbox(run, writer, events, step, done.ms);
  }

  if (sandboxed) await threadsRepo().addTaint(run.roomId, run.number, ["sandbox"]);
  const started = logged("step.started") ?? await writer.append({ type: "step.started", step, call, detail: toolDetail(call) });
  await notifyRun(run.roomId, await runs.progress(run, { steps: step, currentStep: call.name }), started.seq);
  const t0 = Date.now();
  const { output, ok, synced } = await runCall(run, call, offered);
  const ms = Date.now() - t0;
  if (synced && hasChanges(synced) && !logged("files.synced")) await writer.append({ type: "files.synced", step, ...synced });
  const finished = await writer.append({ type: "step.finished", step, output, ms, ok });
  await notifyRun(run.roomId, await runs.stepDone(run), finished.seq);
  return sandboxed ? billSandbox(run, writer, events, step, ms) : { steps: step, costMicros: run.costMicros };
}
