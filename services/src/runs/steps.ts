import { agentOrDefault } from "../agents/model.js";
import { agentsRepo } from "../agents/repo.js";
import { deniedResult, expiredResult, unsure } from "../approvals/model.js";
import type { Approval } from "../approvals/repo.js";
import { auditRepo } from "../audit/repo.js";
import { budgetRepo } from "../budget/repo.js";
import { connectionsRepo } from "../connections/repo.js";
import { sleep } from "../lib/sleep.js";
import { mcpServerOf } from "../mcp/client/tools.js";
import { memoryRepo } from "../memory/repo.js";
import { JOBS, modelInfo, NAMING_MODEL, ROUTER_MODEL, type ModelPick } from "../models/catalog.js";
import { gateway } from "../models/index.js";
import { NAME_PROMPT, type ModelChunk, type ModelGateway, type ModelRequest, type ToolCall, type ToolSpec } from "../models/gateway.js";
import { modelIdOf, parseRoute, ROUTER_PROMPT, routerInput } from "../models/picks.js";
import { mergeTaint, messageTaint, runRefusal } from "../models/privacy.js";
import { isNumberedName } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { Agent, RunEndStatus, RunEvent, Source } from "../threads/types.js";
import { findTool, toolEnv } from "../tools/index.js";
import type { Tool, ToolEnv, ToolResult } from "../tools/types.js";
import { sandboxCostMicros } from "../workspace/limits.js";
import { runSandbox } from "../workspace/session.js";
import type { FilesSynced } from "../workspace/types.js";
import { answerOf, buildContext, inLane, threadMessages } from "./context.js";
import { finishRun } from "./finish.js";
import { endReason, stoppedBy } from "./model.js";
import { notifyRun } from "./notify.js";
import { systemPrompt } from "./prompt.js";
import { runsRepo, type Run } from "./repo.js";
import { delegateSpec, mayRun, runTool, SANDBOX_TOOL, toolDetail, toolsFor } from "./tools.js";

/*
 * The bodies of the run loop's durable steps. A step that fails is run again with the same input, so each one reads
 * what an earlier attempt wrote and skips it: logged steers and tool steps, and model calls already recorded.
 */

const FLUSH_MS = 250;
const STOP_POLL_MS = 1000;
/** Long enough for a send that has taken its seq to finish writing its message. */
const HOLE_WAIT_MS = 1000;
const LENGTH_NOTE = "\n\n(The answer was cut off at the length limit.)";
const REFUSED = "The model declined this request. Try another model.";
const DROPPED = "The model's connection dropped mid-answer.";

type End = { status: RunEndStatus; reason?: string };
type Writer = Awaited<ReturnType<ReturnType<typeof runsRepo>["eventWriter"]>>;
/** `ms`: how long the model call took. */
type Usage = Extract<ModelChunk, { type: "usage" }> & { ms?: number };
/** A helper's lane, the main lane's delegate step that started it, the task it was handed and who handed it over. */
type Helper = { lane: number; step: number; task: string; parent: string };
/**
 * A run once its model is settled, with the agent that answers it and the room's other agents, as `load` read them.
 * A helper works on the same run from its own lane, with its own agent and model, and no others: it can't hand on.
 */
export type RoutedRun = Run & { model: string; agent: Agent; others: Agent[]; helper?: Helper };

export const laneOf = (run: RoutedRun) => run.helper?.lane ?? 0;
/**
 * A helper's durable steps and recorded calls carry its lane in their names (`h1-model-1`). The markers are kept per
 * run, so without it a helper's turn would find the main agent's turn of the same number already recorded.
 */
export const laneName = (run: RoutedRun, name: string) => (run.helper ? `h${run.helper.lane}-${name}` : name);

let shared: ModelGateway | undefined;
/** One gateway per container, so its SDK clients keep their connections alive from one call to the next. */
export const models = () => (shared ??= gateway());

/** The room's connections, with its id, as the tool lookups take them. */
export const roomConnections = async (roomId: string) => ({ roomId, ...await connectionsRepo().get(roomId) });

/** The thread a tool call is made for, as the tools see it. */
export const toolRoom = (run: RoutedRun, tainted: boolean): ToolEnv["room"] =>
  ({ roomId: run.roomId, threadNumber: run.number, agentName: run.agent.name, tainted });

/**
 * Null when the run is already over (its start failed after the invoke was accepted). The agent is read once, here,
 * so an edit made while the run works applies from the next run on. One deleted since the run started is the built-in.
 */
export async function load(runId: string): Promise<{ run: Run; provisional: boolean; agent: Agent; others: Agent[] } | null> {
  const run = await runsRepo().getRun(runId);
  if (run?.status !== "running") return null;
  const agents = agentsRepo();
  const [thread, stored, all] = await Promise.all([
    threadsRepo().threadById(run.roomId, run.threadId), agents.byId(run.roomId, run.agentId), agents.list(run.roomId),
  ]);
  const agent = agentOrDefault(stored);
  // A thread keeps its `thread-<N>` name until someone or a run names it; names like that can't be picked.
  return { run, provisional: !!thread && isNumberedName(thread.name), agent, others: all.filter((a) => a.agentId !== agent.agentId) };
}

/** Stop, budget, steps and time, checked before every model call and every tool call. */
export async function limitsReached(run: Run): Promise<End | null> {
  const [current, budget] = await Promise.all([runsRepo().getRun(run.runId), budgetRepo().get(run.roomId, new Date())]);
  return endReason({
    stopRequestedBy: current?.stopRequestedBy, steps: run.steps, startedAtMs: Date.parse(run.startedAt), pausedMs: current?.pausedMs,
    spentMicros: budget.spentMicros, capMicros: budget.capMicros, month: budget.month,
  }, Date.now());
}

const budgetLeft = async (run: Run) => {
  const budget = await budgetRepo().get(run.roomId, new Date());
  return budget.spentMicros < budget.capMicros;
};

/** The run's cost so far: the sum of the calls it has recorded, a retried step's earlier attempts included. */
export const costOf = (events: RunEvent[]) => events.reduce((sum, e) => sum + (e.type === "usage" ? e.costMicros : 0), 0);

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

/**
 * One model call, read to its end. A call that throws comes back failed, with what arrived first, its usage included.
 * Its usage carries how long it took.
 */
async function callModel(request: ModelRequest, onText?: (text: string) => void): Promise<Call> {
  const call: Call = { text: "", toolCalls: [], failed: false };
  const t0 = Date.now();
  try {
    for await (const chunk of models().stream(request)) {
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
  if (call.usage) call.usage.ms = Date.now() - t0;
  return call;
}

type Choice = { model: string; by: "pick" | "default" | "auto"; costMicros: number };
/** What to choose for: the pick, the step whose result the router's call settles, and the message Auto routes on. */
type Ask = { pick: ModelPick; by: "pick" | "default"; step: string; message: () => Promise<{ author: string; text: string }> };

/**
 * A pick names its model. Auto asks the router on Haiku to choose Haiku or Sonnet from the message, and takes Sonnet
 * without asking once the budget is spent, or when the router fails or declines. A retried step keeps the router's
 * recorded choice instead of asking again.
 */
export async function chooseModel(run: Run, writer: Writer, ask: Ask): Promise<Choice> {
  if (ask.pick !== "auto") return { model: modelIdOf(ask.pick), by: ask.by, costMicros: run.costMicros };
  const recorded = await runsRepo().recorded<Choice>(run.runId, ask.step);
  if (recorded) return recorded;
  const sonnet = modelIdOf("sonnet");
  if (!await budgetLeft(run)) return { model: sonnet, by: "auto", costMicros: run.costMicros };
  const { author, text } = await ask.message();
  const call = await callModel({
    model: ROUTER_MODEL, system: ROUTER_PROMPT, tools: [], ...JOBS.route, messages: [{ role: "user", author, text: routerInput(text) }],
  });
  const choice: Choice = {
    model: call.failed || call.end?.stop === "refusal" ? sonnet : parseRoute(call.text), by: "auto",
    costMicros: run.costMicros + (call.usage?.costMicros ?? 0),
  };
  return call.usage ? recordCall(run, writer, { model: ROUTER_MODEL, job: "route", step: ask.step }, call.usage, choice) : choice;
}

/** Settles the model the run answers on, from its first message, before its first model call. Logs `routed` once. */
export async function routeRun(run: Run): Promise<{ model: string; costMicros: number }> {
  const runs = runsRepo();
  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const choice = await chooseModel(run, writer, {
    pick: run.pick, by: run.pickBy, step: "route",
    message: async () => {
      const first = (await runs.prior(run.threadId, run.firstSeq)).at(-1);
      return { author: first?.authorName ?? "", text: first?.text ?? "" };
    },
  });
  const logged = events.find((e) => e.type === "routed");
  const routed = logged ?? await writer.append({ type: "routed", model: choice.model, by: choice.by });
  const thread = await runs.progress(run, { model: choice.model });
  if (!logged && thread) await notifyRun(run.roomId, thread, routed.seq);
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
  const messages = buildContext(threadMessages(await runs.prior(run.threadId, run.firstSeq)), []);
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
      if (m.seq > steered) {
        const attachments = m.attachments.length ? { attachments: m.attachments.map((a) => a.name) } : {};
        events.push(await writer.append({ type: "steer", messageSeq: m.seq, authorName: m.authorName, text: m.text, ...attachments }));
      }
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

/** `tainted`: the thread held private content when the model answered, which its tool calls' gates need. */
type Turn = { toolCalls: ToolCall[]; seenSeq: number; costMicros: number; end?: End; tainted?: boolean };

/**
 * One model call: the loop's `model-<turn>` step. First the limits, then the messages members sent since the run
 * last looked, which become steers, then the privacy gate. The answer streams into the event log in 250 ms batches,
 * and a stop requested meanwhile aborts the call within a second, keeping what was written. What an earlier attempt
 * wrote for this turn without recording its call (its text and native turn) is voided by a `text.reset` before the
 * model answers again. A helper's turn is the same, in its lane, except that it reads no steers: it hears only its
 * task, and what members send meanwhile waits for the thread's own agent, whose next turn reads it.
 */
export async function modelTurn(run: RoutedRun, turn: number): Promise<Turn> {
  const runs = runsRepo();
  const recorded = await runs.recorded<Turn>(run.runId, laneName(run, `model-${turn}`));
  if (recorded) return recorded;
  const lane = laneOf(run);
  const [events, writer, end] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId, lane), limitsReached(run)]);
  if (end) return { toolCalls: [], seenSeq: run.seenSeq, costMicros: costOf(events), end };

  const seenSeq = run.helper ? run.seenSeq : await readSteers(run, events, writer);
  const [prior, steers, thread, room, memory] = await Promise.all([
    runs.prior(run.threadId, run.firstSeq), runs.unread(run.threadId, run.firstSeq), threadsRepo().threadById(run.roomId, run.threadId),
    roomConnections(run.roomId), memoryRepo().entries(run.roomId),
  ]);
  // The thread's taint is written after a send is acknowledged, so it can lag behind a file that just landed; the
  // messages this call would carry, the thread and every steer, are checked themselves.
  const taint = mergeTaint(thread?.taint ?? [], ...[...prior, ...steers].map(messageTaint));
  const refused = runRefusal(run.model, taint);
  if (refused) return { toolCalls: [], seenSeq, costMicros: costOf(events), end: refused };

  if (events.some((e) => inLane(lane)(e) && (e.type === "text" || e.type === "model.turn") && e.turn === turn)) {
    events.push(await writer.append({ type: "text.reset", turn }));
  }
  const delegate = delegateSpec(run.others);
  const tools = [
    ...toolsFor(run.model, models().servedBy(run.model), { ...room, github: room.github !== null }, run.agent.tools),
    ...(delegate ? [delegate] : []),
  ];
  // Memory is read every turn, so what this run or another one saved since is there for the next call.
  const system = systemPrompt({
    agent: run.agent, others: run.others, memory, privateOk: modelInfo(run.model).privateOk, helperOf: run.helper?.parent,
  });
  const opening = run.helper ? [{ role: "user" as const, author: run.helper.parent, text: run.helper.task }] : threadMessages(prior);
  return stream(run, writer, buildContext(opening, events, lane), events, { turn, seenSeq, system, tools, tainted: taint.length > 0 });
}

async function stream(
  run: RoutedRun, writer: Writer, messages: ReturnType<typeof buildContext>, events: RunEvent[],
  at: { turn: number; seenSeq: number; system: string; tools: ToolSpec[]; tainted: boolean },
): Promise<Turn> {
  const { turn, seenSeq, system, tools, tainted } = at;
  const stop = watchStop(run.runId);
  let failure: unknown;
  let pending = "";
  let wrote = false;
  // Each turn's text after the first starts a new paragraph, in the log itself, so the stored answer and the streamed
  // one stay the same text.
  let lead = answerOf(events, laneOf(run)).text ? "\n\n" : "";
  const flush = async () => {
    if (!pending) return;
    const text = lead + pending;
    lead = "";
    pending = "";
    await writer.append({ type: "text", text, turn });
    wrote = true;
  };
  const flusher = setInterval(() => flush().catch((e) => { failure ??= e; stop.abort(); }), FLUSH_MS);

  let call: Call;
  try {
    call = await callModel(
      { model: run.model, system, messages, tools, ...JOBS.run, signal: stop.signal }, (text) => { pending += text; },
    );
  } finally {
    clearInterval(flusher);
    stop.close();
  }
  await flush().catch((e) => { failure ??= e; });
  const stopper = stop.stoppedBy();
  const spent = costOf(events);
  // The provider billed the attempt, dropped or not, so it is charged before the step is retried. A writer refuses
  // every append after one fails, so then the charge goes through a fresh one, which starts after the last event that
  // landed.
  const chargeAndRetry = async (error: unknown, logFailed: boolean): Promise<never> => {
    if (call.usage) {
      const charger = logFailed ? await runsRepo().eventWriter(run.runId, laneOf(run)) : writer;
      await recordCall(run, charger, { model: run.model, job: "run" }, call.usage, { costMicros: spent + call.usage.costMicros });
    }
    throw error;
  };
  // A model may reject its stream once aborted; a stop is not an error. A call that dropped before showing anything
  // is tried again, as is one whose text didn't all reach the log; a drop after text ends the run instead, since a
  // fresh answer would replace the one members were already reading.
  if (failure || (call.failed && !wrote && !stopper)) return chargeAndRetry(failure ?? call.error, !!failure);
  const cutOff = !stopper && !call.failed && call.end?.stop === "max_tokens";
  try {
    if (call.end?.native) await writer.append({ type: "model.turn", ...call.end.native, turn });
    if (cutOff) await writer.append({ type: "text", text: LENGTH_NOTE, turn });
  } catch (e) {
    return chargeAndRetry(e, true);
  }
  const settle = (result: Pick<Turn, "toolCalls" | "end">) => {
    const turnResult = { ...result, seenSeq, costMicros: spent + (call.usage?.costMicros ?? 0), tainted };
    if (!call.usage) return turnResult;
    return recordCall(run, writer, { model: run.model, job: "run", step: laneName(run, `model-${turn}`) }, call.usage, turnResult);
  };
  if (stopper) return settle({ toolCalls: [], end: stoppedBy(stopper) });
  if (call.failed) return settle({ toolCalls: [], end: { status: "failed", reason: DROPPED } });
  if (call.end?.stop === "refusal") return settle({ toolCalls: [], end: { status: "failed", reason: REFUSED } });
  // The tool calls of a cut-off turn may be cut off too, so none of them runs.
  if (cutOff) return settle({ toolCalls: [], end: { status: "done" } });
  return settle({ toolCalls: call.toolCalls });
}

type StepResult = { steps: number; costMicros: number; end?: End };

/**
 * Ends a run that hit an error it couldn't get past. Its cost is summed from its usage events: the total stored on
 * the run is written after each charge commits, so a failure in between leaves it short of what the room paid.
 */
export async function failRun(runId: string) {
  const runs = runsRepo();
  const [run, events] = await Promise.all([runs.getRun(runId), runs.allEvents(runId)]);
  if (!run) return null;
  return finishRun({ ...run, costMicros: costOf(events) }, { status: "failed", reason: "The agent hit an error." }, { seenSeq: run.seenSeq, force: true });
}

/**
 * Sandbox time, billed like a model call so it counts towards the run's cost and the room's budget. Its marker holds
 * the step's result, so a retry that finds the step finished bills it only when no earlier attempt did.
 */
const billSandbox = (run: Run, writer: Writer, events: RunEvent[], step: number, ms: number): Promise<StepResult> => {
  const usage: Usage = { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: sandboxCostMicros(ms) };
  const result = { steps: step, costMicros: costOf(events) + usage.costMicros };
  return recordCall(run, writer, { model: "sandbox", job: "sandbox", step: `sandbox-${step}` }, usage, result);
};

const hasChanges = (s: FilesSynced) => s.written.length + s.deleted.length + s.notes.length > 0;

type Outcome = { output: string; ok: boolean; synced?: FilesSynced; sources?: Source[]; ms?: number };
type Room = Awaited<ReturnType<typeof roomConnections>>;
type RoomCall = { room: Room; settled?: Approval; started: RunEvent; rerun: boolean; envOf: typeof toolEnv };

/** What the model is told in place of a write's result when it wasn't approved. */
function unapproved(settled: Approval | undefined): string {
  switch (settled?.status) {
    case "denied":
      return deniedResult(settled.by ?? "a member");
    case "expired":
      return expiredResult(Math.round((Date.parse(settled.expiresAt) - Date.parse(settled.requestedAt)) / 1000));
    case "cancelled":
      return "Cancelled: the run was stopped.";
    default:
      return "This write needs a room member's approval first.";
  }
}

/**
 * A web, GitHub or MCP call. A write, or a web call that was gated, runs only once approved, with the input the
 * approval showed. A write never runs twice: a retry that finds its step already started can't know whether GitHub
 * or the MCP server took the first try. GitHub data and MCP output taint the thread before any of it is logged.
 */
async function runRoomTool(run: RoutedRun, tool: Tool, call: ToolCall, { room, settled, started, rerun, envOf }: RoomCall): Promise<ToolResult> {
  const [transport, thread] = await Promise.all([
    envOf(process.env.TOOL_MODE, room.github ?? undefined), threadsRepo().threadById(run.roomId, run.threadId),
  ]);
  const env = { ...transport, room: toolRoom(run, !!thread?.taint.length) };
  const input = settled?.call.input ?? call.input;
  const refused = tool.check?.(input, env);
  if (refused) return { ok: false, output: refused };
  if ((tool.write || settled) && settled?.status !== "approved") return { ok: false, output: unapproved(settled) };
  if (tool.write && rerun) return { ok: false, output: unsure(tool.kind === "mcp" ? mcpServerOf(call.name) : "GitHub") };
  if (tool.kind === "github" || tool.kind === "mcp") await threadsRepo().addTaint(run.roomId, run.number, [tool.kind]);
  await auditRepo().record(run.roomId, {
    id: `${run.runId}#${started.seq}`, at: started.at, actor: "agent", kind: "tool", threadNumber: run.number, tool: call.name,
    detail: tool.detail(input), agent: run.agent.name,
  });
  return tool.run(input, env);
}

/**
 * Only a tool the model could be offered runs, so a model kept from private content can't reach it by naming it. A stop
 * requested while the sandbox or the fake lookup works cuts it short. A sandbox step reports its own time, since a
 * retry of it reuses what an earlier attempt ran.
 */
async function runCall(run: RoutedRun, call: ToolCall, offered: boolean, step: number, roomCall: RoomCall): Promise<Outcome> {
  if (!offered) return { ok: false, output: `Unknown tool ${call.name}.` };
  const tool = findTool(call.name, roomCall.room);
  if (tool) return runRoomTool(run, tool, call, roomCall);
  const sandboxed = call.name === SANDBOX_TOOL.name;
  // Each approval the run waited on moved its dead time, which only the stored run knows; a session lives until then.
  const deadAt = sandboxed ? (await runsRepo().getRun(run.runId))?.deadAt ?? run.deadAt : run.deadAt;
  const stop = watchStop(run.runId);
  const work = sandboxed
    ? runSandbox({ ...run, deadAt }, step, call.input, { signal: stop.signal })
    : runTool(call, { sleep, signal: stop.signal });
  return work.finally(stop.close);
}

/**
 * One tool call: one step. The limits are checked first, so a stop never waits for another tool. A sandbox step taints
 * the thread before any code runs, since its output carries room files, and is billed after it finishes, once: a retry
 * that finds the step finished but unbilled only bills it. A write comes with its settled approval.
 */
export async function toolStep(
  run: RoutedRun, call: ToolCall, settled?: Approval, envOf = toolEnv,
): Promise<StepResult> {
  const end = await limitsReached(run);
  if (end) return { steps: run.steps, costMicros: run.costMicros, end };

  const runs = runsRepo();
  const step = run.steps + 1;
  const [events, writer, room] = await Promise.all([
    runs.allEvents(run.runId), runs.eventWriter(run.runId, laneOf(run)), roomConnections(run.roomId),
  ]);
  const logged = (type: string) => events.find((e) => (e.type === type) && "step" in e && e.step === step);
  const offered = mayRun(run.model, models().servedBy(run.model), call.name, room, run.agent.tools);
  const sandboxed = offered && call.name === SANDBOX_TOOL.name;
  // An earlier attempt finished the tool and logged it, and only failed after: its result stands.
  const done = logged("step.finished");
  if (done?.type === "step.finished") {
    if (!sandboxed) return { steps: step, costMicros: run.costMicros };
    return await runs.recorded<StepResult>(run.runId, `sandbox-${step}`) ?? billSandbox(run, writer, events, step, done.ms);
  }

  if (sandboxed) await threadsRepo().addTaint(run.roomId, run.number, ["sandbox"]);
  const before = logged("step.started");
  const started = before ?? await writer.append({ type: "step.started", step, call, detail: toolDetail(call, room) });
  const currentStep = run.helper ? `${run.agent.name} › ${call.name}` : call.name;
  await notifyRun(run.roomId, await runs.progress(run, { steps: step, currentStep }), started.seq);
  const t0 = Date.now();
  const result = await runCall(run, call, offered, step, { room, settled, started, rerun: !!before, envOf });
  const { output, ok, synced, sources } = result;
  const ms = result.ms ?? Date.now() - t0;
  if (synced && hasChanges(synced) && !logged("files.synced")) await writer.append({ type: "files.synced", step, ...synced });
  const finished = await writer.append({ type: "step.finished", step, output, ms, ok, ...(sources && { sources }) });
  await notifyRun(run.roomId, await runs.stepDone(run), finished.seq);
  return sandboxed ? billSandbox(run, writer, events, step, ms) : { steps: step, costMicros: run.costMicros };
}
