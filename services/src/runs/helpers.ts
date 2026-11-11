import { modelInfo } from "../models/catalog.js";
import type { ToolCall } from "../models/gateway.js";
import { resolvePick } from "../models/picks.js";
import { mergeTaint, type TaintSource } from "../models/privacy.js";
import { summaryLine } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { Agent, RunEvent, ToolKind } from "../threads/types.js";
import { answerOf, inLane } from "./context.js";
import { notifyRun } from "./notify.js";
import { runsRepo } from "./repo.js";
import { roomDefaultModel } from "./start.js";
import { chooseModel, costOf, laneName, limitsReached, type End, type RoutedRun, type StepResult } from "./steps.js";
import { firstLine } from "./tools.js";

/*
 * The two steps around a helper's work: the delegate step starts in the main lane, the helper works in a lane of its
 * own, and the delegate step finishes with the helper's answer as its result.
 */

/** The longest helper answer the delegating agent reads, so one long answer can't crowd out its own context. */
const MAX_ANSWER = 20_000;
const ERROR = "The agent hit an error.";


export const noSuchAgent = (name: string, others: Agent[]) =>
  `There's no @${name} in this room. Agents: ${others.map((a) => `@${a.name}`).join(", ")}.`;

/** The delegate step's result, as the agent that delegated reads it: the helper's answer, or why it has none. */
export function delegateResult(agent: string, end: End, answer: string): { ok: boolean; output: string } {
  if (end.status !== "done") return { ok: false, output: `@${agent} couldn't finish: ${end.reason ?? ERROR}` };
  const chars = Array.from(answer);
  return { ok: true, output: chars.length > MAX_ANSWER ? `${chars.slice(0, MAX_ANSWER).join("")}\n…(cut)` : answer };
}

const stepEvent = (events: RunEvent[], type: RunEvent["type"], step: number) =>
  events.find((e) => e.type === type && "step" in e && e.step === step);

/**
 * The delegate step's start, which a retry repeats without logging anything twice. It logs the main lane's step, then
 * either refuses an agent the room doesn't have (the run's own agent is not among `others`) or hands the task to the
 * named one: the next lane, and the helper's model, picked as a new run's would be from the agent's own model, Auto
 * routing on the task, kept off models that may not see the private content the thread or the delegating turn holds
 * (`taint`, which the thread's stored one can lag behind). The handover is the helper's run, which starts at the
 * delegate step's number, so its steps follow on from it.
 */
export async function startHelper(
  run: RoutedRun, call: ToolCall, taint: TaintSource[],
): Promise<{ helper: RoutedRun } | { result: StepResult }> {
  const end = await limitsReached(run);
  if (end) return { result: { steps: run.steps, costMicros: run.costMicros, end } };

  const runs = runsRepo();
  const step = run.steps + 1;
  const name = String(call.input.agent ?? "").replace(/^@/, "");
  const task = String(call.input.task ?? "");
  const events = await runs.allEvents(run.runId);
  const started = stepEvent(events, "step.started", step) ?? await (await runs.eventWriter(run.runId)).append({
    type: "step.started", step, call, detail: `${name}: ${Array.from(firstLine(task)).slice(0, 60).join("")}`,
  });
  await notifyRun(run.roomId, await runs.progress(run, { steps: step, currentStep: name }), started.seq);

  const agent = run.others.find((a) => a.name === name);
  if (!agent) {
    const refused = stepEvent(events, "step.finished", step) ?? await (await runs.eventWriter(run.runId)).append({
      type: "step.finished", step, output: noSuchAgent(name, run.others), ms: Date.now() - Date.parse(started.at), ok: false,
    });
    await notifyRun(run.roomId, await runs.stepDone(run), refused.seq);
    return { result: { steps: step, costMicros: run.costMicros } };
  }

  // Helpers work one at a time, each in the lane after the last one's.
  const helpers = events.filter((e) => e.type === "helper.started");
  const lane = helpers.find((e) => e.step === step)?.lane ?? helpers.length + 1;
  const helper: RoutedRun = { ...run, agent: { ...agent, tools: helperKinds(agent.tools, run.model) }, others: [], steps: step, helper: { lane, step, task, parent: run.agent.name } };
  const [thread, roomDefault] = await Promise.all([threadsRepo().threadById(run.roomId, run.threadId), roomDefaultModel(run.roomId)]);
  const pick = resolvePick(undefined, agent.model === "room" ? roomDefault : agent.model, mergeTaint(thread?.taint ?? [], taint));
  const writer = await runs.eventWriter(run.runId, lane);
  const choice = await chooseModel(helper, writer, {
    ...pick, step: laneName(helper, "route"), message: async () => ({ author: run.agent.name, text: task }),
  });
  if (!stepEvent(events, "helper.started", step)) {
    await writer.append({ type: "helper.started", step, agentId: agent.agentId, agentName: agent.name, task, model: choice.model });
  }
  return { helper: { ...helper, model: choice.model, costMicros: choice.costMicros } };
}

/**
 * A helper's answer goes to its parent's model. GitHub, MCP and the sandbox return content that makes the thread
 * private, after which a parent that may not see private content could only refuse, so its helpers get the web alone.
 */
export const helperKinds = (kinds: ToolKind[], parentModel: string): ToolKind[] =>
  modelInfo(parentModel).privateOk ? kinds : kinds.filter((k) => k === "web");

/**
 * The delegate step's end: the helper's ending in its own lane, then the main lane's step with the helper's answer as
 * its result. A helper whose work failed outright comes as `undefined` and reads as an error. The run's step count and
 * cost are read from the log, so they hold whatever the helper got through.
 */
export async function finishHelper(helper: RoutedRun, ended: End | undefined): Promise<StepResult> {
  const { lane, step } = helper.helper!;
  const end = ended ?? { status: "failed", reason: ERROR };
  const runs = runsRepo();
  const events = await runs.allEvents(helper.runId);
  const answer = answerOf(events, lane);
  const steps = Math.max(step, ...events.flatMap((e) => (e.type === "step.started" ? [e.step] : [])));
  const since = (type: RunEvent["type"]) => Date.now() - Date.parse(stepEvent(events, type, step)!.at);

  if (!stepEvent(events, "helper.finished", step)) {
    await (await runs.eventWriter(helper.runId, lane)).append({
      type: "helper.finished", step, status: end.status, summary: end.status === "done" ? summaryLine(answer.final) : end.reason ?? ERROR,
      steps: steps - step, ms: since("helper.started"), costMicros: costOf(events.filter(inLane(lane))),
    });
  }
  const finished = stepEvent(events, "step.finished", step) ?? await (await runs.eventWriter(helper.runId)).append({
    type: "step.finished", step, ...delegateResult(helper.agent.name, end, answer.text), ms: since("step.started"),
  });
  await notifyRun(helper.roomId, await runs.stepDone(helper), finished.seq);
  return { steps, costMicros: costOf(events) };
}
