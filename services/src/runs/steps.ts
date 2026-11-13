import { agentOrDefault, delegatesTo } from "../agents/model.js";
import { agentsRepo } from "../agents/repo.js";
import { auditRepo } from "../audit/repo.js";
import { budgetRepo } from "../budget/repo.js";
import { connectionsRepo } from "../connections/repo.js";
import { gateway } from "../models/index.js";
import type { ModelChunk, ModelGateway, ModelRequest, ToolCall } from "../models/gateway.js";
import { isNumberedName } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { Agent, RunEndStatus, RunEvent } from "../threads/types.js";
import type { ToolEnv } from "../tools/types.js";
import { finishRun } from "./finish.js";
import { endReason, stoppedBy } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { agentCard, type AgentCard } from "./tools.js";

/*
 * What the run loop's durable steps share (the model turn, the tool step and the routing steps live beside this). A
 * step that fails is run again with the same input, so each one reads what an earlier attempt wrote and skips it:
 * logged steers and tool steps, and model calls already recorded.
 */

const STOP_POLL_MS = 1000;

export type End = { status: RunEndStatus; reason?: string };
export type Writer = Awaited<ReturnType<ReturnType<typeof runsRepo>["eventWriter"]>>;
/** `ms`: how long the model call took. */
export type Usage = Extract<ModelChunk, { type: "usage" }> & { ms?: number };
/** A helper's lane, the main lane's delegate step that started it, the task it was handed and who handed it over. */
type Helper = { lane: number; step: number; task: string; parent: string };
/**
 * A run once its model is settled, with the agent that answers it and the room's other agents, as `load` read them.
 * A helper works on the same run from its own lane, with its own agent and model, and no others: it can't hand on.
 */
export type RoutedRun = Run & { model: string; agent: Agent; others: AgentCard[]; helper?: Helper };

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

/** The run and thread a tool call is made for, as the tools see them. */
export const toolRoom = (run: RoutedRun, { tainted, postCap }: { tainted: boolean; postCap: number }): ToolEnv["room"] => ({
  roomId: run.roomId, threadId: run.threadId, threadNumber: run.number, runId: run.runId, agentId: run.agent.agentId,
  agentName: run.agent.name, tainted, postCap,
});

/**
 * One audit row per tool step that runs, in the name of the agent that ran it. Its id and time are the step's start
 * event's, so a retried step finds its row already there.
 */
export const auditTool = (run: RoutedRun, started: RunEvent, tool: string, detail: string) => auditRepo().record(run.roomId, {
  id: `${run.runId}#${started.seq}`, at: started.at, actor: "agent", kind: "tool", threadNumber: run.number, tool, detail, agent: run.agent.name,
});

/**
 * Null when the run is already over (its start failed after the invoke was accepted). The agent is read once, here,
 * so an edit made while the run works applies from the next run on. One deleted since the run started is the built-in.
 */
export async function load(runId: string): Promise<{ run: Run; provisional: boolean; agent: Agent; others: AgentCard[] } | null> {
  const run = await runsRepo().getRun(runId);
  if (run?.status !== "running") return null;
  const agents = agentsRepo();
  const [thread, stored, all] = await Promise.all([
    threadsRepo().threadById(run.roomId, run.threadId), agents.byId(run.roomId, run.agentId), agents.list(run.roomId),
  ]);
  const agent = agentOrDefault(stored);
  // A thread keeps its `thread-<N>` name until someone or a run names it; names like that can't be picked.
  return { run, provisional: !!thread && isNumberedName(thread.name), agent, others: all.filter((a) => a.agentId !== agent.agentId && delegatesTo(agent, a.agentId)).map(agentCard) };
}

/**
 * Stop, archive, budget, steps and time, checked before every model call and every tool call. An archived room takes
 * no decisions; archiving cancels and wakes a run waiting on one, which then ends here.
 */
export async function limitsReached(run: Run): Promise<End | null> {
  const [current, { budget, archived }] = await Promise.all([
    runsRepo().getRun(run.runId), budgetRepo().withArchived(run.roomId, new Date()),
  ]);
  return endReason({
    stopRequestedBy: current?.stopRequestedBy, archived, steps: run.steps, startedAtMs: Date.parse(run.startedAt), pausedMs: current?.pausedMs,
    spentMicros: budget.spentMicros, capMicros: budget.capMicros, month: budget.month,
  }, Date.now());
}

export const budgetLeft = async (run: Run) => {
  const budget = await budgetRepo().get(run.roomId, new Date());
  return budget.spentMicros < budget.capMicros;
};

/** The run's cost so far: the sum of the calls it has recorded, a retried step's earlier attempts included. */
export const costOf = (events: RunEvent[]) => events.reduce((sum, e) => sum + (e.type === "usage" ? e.costMicros : 0), 0);

/** Polls the run's stop flag every second, and aborts the signal once a member has asked the run to stop. */
export function watchStop(runId: string) {
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
 * Which call a usage event bills, and the step whose result that call settles, if it settles one. `toolStep` is the
 * step an image was made in, logged on its usage so a retry of that step can see the image paid for.
 */
type Meter = { model: string; job: "route" | "name" | "run" | "sandbox" | "image"; step?: string; toolStep?: number };

/**
 * Every model call is metered, once: its usage event and the room's monthly spend are one transaction. A call that
 * settles its step adds a marker holding the step's result, which the transaction refuses to repeat; a retried step
 * looks for the marker first and returns the result it holds, so that call is neither charged nor made twice. A call
 * whose step is about to be retried has no marker: the provider billed it, and the retry is a new call. The room
 * hears the cost at once, so cost and budget move while a long answer streams.
 */
export async function recordCall<T extends { costMicros: number }>(run: Run, writer: Writer, meter: Meter, usage: Usage, result: T): Promise<T> {
  const runs = runsRepo();
  const marker = meter.step ? [runs.callMarker(run.runId, meter.step, result)] : [];
  const event = await writer.append({ ...usage, model: meter.model, job: meter.job, step: meter.toolStep }, [
    ...marker, budgetRepo().spend(run.roomId, usage.costMicros, new Date()),
  ]);
  await notifyRun(run.roomId, await runs.progress(run, { costMicros: result.costMicros }), event.seq);
  return result;
}

export type Call = { text: string; toolCalls: ToolCall[]; usage?: Usage; end?: Extract<ModelChunk, { type: "end" }>; failed: boolean; error?: unknown };

/**
 * One model call, read to its end. A call that throws comes back failed, with what arrived first, its usage included.
 * Its usage carries how long it took.
 */
export async function callModel(request: ModelRequest, onText?: (text: string) => void): Promise<Call> {
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

export type StepResult = { steps: number; costMicros: number; end?: End };

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
