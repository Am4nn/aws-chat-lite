import { sleep } from "../lib/sleep.js";
import { memoryRepo } from "../memory/repo.js";
import { JOBS, modelInfo } from "../models/catalog.js";
import type { ModelMessage, ToolCall, ToolSpec } from "../models/gateway.js";
import { loadImages } from "../models/vision.js";
import { mergeTaint, messageTaint, runRefusal, type TaintSource } from "../models/privacy.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEvent } from "../threads/types.js";
import { answerOf, askedAgents, buildContext, channelBackground, inLane, threadMessages } from "./context.js";
import { stoppedBy } from "./model.js";
import { systemPrompt } from "./prompt.js";
import { runsRepo, type Run } from "./repo.js";
import { delegateSpec, toolsFor } from "./tools.js";
import {
  callModel, costOf, laneName, laneOf, limitsReached, models, recordCall, roomConnections, watchStop,
  type Call, type End, type RoutedRun, type Writer,
} from "./steps.js";

const FLUSH_MS = 250;
/** Long enough for a send that has taken its seq to finish writing its message. */
const HOLE_WAIT_MS = 1000;
const LENGTH_NOTE = "\n\n(The answer was cut off at the length limit.)";
const REFUSED = "The model declined this request. Try another model.";
const DROPPED = "The model's connection dropped mid-answer.";

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
        const attachments = m.attachments.length ? { attachments: m.attachments.map(({ url: _url, ...a }) => a) } : {};
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

/** `taint`: the private content the thread held when the model answered, which its tool calls' gates need. */
type Turn = { toolCalls: ToolCall[]; seenSeq: number; costMicros: number; end?: End; taint?: TaintSource[] };

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
  const [prior, steers, thread, room, memory, background] = await Promise.all([
    runs.prior(run.threadId, run.firstSeq), runs.unread(run.threadId, run.firstSeq), threadsRepo().threadById(run.roomId, run.threadId),
    roomConnections(run.roomId), memoryRepo().entries(run.roomId), run.helper ? null : runs.background(run),
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
  // Memory is read every turn, so what this run or another one saved since is there for the next call. Private entries
  // go only into threads that are already private: a clean thread holding one could pass it on, through a public save,
  // a helper or its own answer, to a model that may not see it.
  const system = systemPrompt({
    agent: run.agent, others: run.others, memory, privateOk: modelInfo(run.model).privateOk && taint.length > 0,
    helperOf: run.helper?.parent, asked: askedAgents(prior, events, run.others),
  });
  const opening = run.helper
    ? [{ role: "user" as const, author: run.helper.parent, text: run.helper.task }]
    : [...channelBackground(background), ...threadMessages(prior)];
  const messages = await loadImages(buildContext(opening, events, lane), run.model);
  return stream(run, writer, messages, events, { turn, seenSeq, system, tools, taint });
}

async function stream(
  run: RoutedRun, writer: Writer, messages: ModelMessage[], events: RunEvent[],
  at: { turn: number; seenSeq: number; system: string; tools: ToolSpec[]; taint: TaintSource[] },
): Promise<Turn> {
  const { turn, seenSeq, system, tools, taint } = at;
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
    const turnResult = { ...result, seenSeq, costMicros: spent + (call.usage?.costMicros ?? 0), taint };
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
