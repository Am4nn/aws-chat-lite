import { deniedResult, expiredResult, unsure } from "../approvals/model.js";
import type { Approval } from "../approvals/repo.js";
import { generateImageStep, imageDeps } from "../images/step.js";
import { sleep } from "../lib/sleep.js";
import { mcpServerOf } from "../mcp/client/names.js";
import type { TokenUsage } from "../models/catalog.js";
import { IMAGE_MODEL } from "../models/images.js";
import type { ToolCall } from "../models/gateway.js";
import { isPrivate, mcpTaint, mergeTaint, ROOM_TAINT, type TaintSource } from "../models/privacy.js";
import { threadsRepo } from "../threads/repo.js";
import type { GeneratedImage, RunEvent, Source } from "../threads/types.js";
import { findTool, toolEnv } from "../tools/index.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { sandboxCostMicros } from "../workspace/limits.js";
import { runSandbox } from "../workspace/session.js";
import type { FilesSynced } from "../workspace/types.js";
import { stepEvent } from "./context.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { asksFirst, IMAGE_GATE, mayRun, runFakeLookup, runGate, SANDBOX_GATE, SANDBOX_TOOL, toolDetail, type Gated } from "./tools.js";
import {
  auditTool, costOf, laneOf, limitsReached, models, recordCall, roomConnections, toolRoom, watchStop,
  type RoutedRun, type StepResult, type Usage, type Writer,
} from "./steps.js";

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

type Outcome = { output: string; ok: boolean; synced?: FilesSynced; sources?: Source[]; ms?: number; image?: GeneratedImage };
type Room = Awaited<ReturnType<typeof roomConnections>>;
/** `taint`: the private content the turn saw, which can be ahead of the thread's stored taint. */
type RoomCall = { room: Room; settled?: Approval; started: RunEvent; rerun: boolean; envOf: typeof toolEnv; taint: TaintSource[] };

/** What the model is told in place of a call's result when it asked first and wasn't approved. */
function unapproved(settled: Approval): string {
  switch (settled.status) {
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

/** The thread's taint with what the model's turn saw, which can be ahead of it. */
const seenBy = async (run: RoutedRun, taint: TaintSource[]) =>
  mergeTaint(taint, (await threadsRepo().threadById(run.roomId, run.threadId))?.taint ?? []);

/**
 * Why a call may not run, or null. One that asked runs only once approved. One that didn't is weighed again, since the
 * room's mode, its sandbox's internet or the thread's taint may have changed since its gate: if it would ask now, the
 * model is told to call it again, and that call's gate shows the card.
 */
function heldBack(tool: Gated, settled: Approval | undefined, seen: TaintSource[], room: Room): string | null {
  if (settled) return settled.status === "approved" ? null : unapproved(settled);
  const rules = { mode: room.approvalMode, sandboxInternet: room.sandboxInternet };
  return asksFirst(tool, seen, rules) ? "This call now needs a room member's approval. Call it again to ask for it." : null;
}

/** Where the model can see whether a write it made went through. */
function writtenTo(tool: Tool, name: string): string {
  if (tool.kind === "mcp") return mcpServerOf(name);
  return tool.kind === "room_post" ? "the chat" : "GitHub";
}

/** What a tool's output brings into the thread: GitHub data, a server's MCP output, or room chat. */
function taintOf(tool: Tool, name: string): TaintSource[] {
  if (tool.kind === "github") return ["github"];
  if (tool.kind === "mcp") return [mcpTaint(mcpServerOf(name))];
  return tool.kind === "room_read" ? [ROOM_TAINT] : [];
}

/**
 * A web, GitHub, MCP, memory or room call. One that asked first runs only once approved, with the input the approval
 * showed; one the room's mode let through runs as the model made it. A write never runs twice: a retry that finds its
 * step already started can't know whether GitHub or the MCP server took the first try. GitHub data, MCP output and
 * room chat taint the thread before any of it is logged, so the next gate and the next model turn see it.
 */
async function runRoomTool(run: RoutedRun, tool: Tool, call: ToolCall, { room, settled, started, rerun, envOf, taint }: RoomCall): Promise<ToolResult> {
  const [transport, seen] = await Promise.all([envOf(process.env.TOOL_MODE, room.github ?? undefined), seenBy(run, taint)]);
  const env = { ...transport, room: toolRoom(run, { tainted: isPrivate(seen), postCap: room.postCap }) };
  const input = settled?.call.input ?? call.input;
  // Its own check comes first: a call it refuses never asked, so telling the model to call again would loop.
  const refused = (await tool.check?.(input, env)) ?? heldBack(tool, settled, seen, room);
  if (refused) return { ok: false, output: refused };
  if (tool.write && rerun) return { ok: false, output: unsure(writtenTo(tool, call.name)) };
  const brings = taintOf(tool, call.name);
  if (brings.length) await threadsRepo().addTaint(run.roomId, run.number, brings);
  await auditTool(run, started, call.name, tool.detail(input));
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
    : runFakeLookup(call, { sleep, signal: stop.signal });
  return work.finally(stop.close);
}

/**
 * One tool call: one step. The limits are checked first, so a stop never waits for another tool. A sandbox step taints
 * the thread before any code runs, since its output carries room files, and is billed after it finishes, once: a retry
 * that finds the step finished but unbilled only bills it. An image step is billed as Gemini answers, once, and its
 * cost is the run's from then on. A call that asked first comes with its settled approval.
 */
export async function toolStep(
  run: RoutedRun, call: ToolCall, settled?: Approval, envOf = toolEnv, taint: TaintSource[] = [],
): Promise<StepResult> {
  const end = await limitsReached(run);
  if (end) return { steps: run.steps, costMicros: run.costMicros, end };

  const runs = runsRepo();
  const step = run.steps + 1;
  const [events, writer, room] = await Promise.all([
    runs.allEvents(run.runId), runs.eventWriter(run.runId, laneOf(run)), roomConnections(run.roomId),
  ]);
  const offered = mayRun(run.model, models().servedBy(run.model), call.name, room, run.agent.tools);
  const gate = offered ? runGate(call.name) : undefined;
  const imaging = gate === IMAGE_GATE;
  // The run's cost after an image step: its usage events, an earlier attempt's charge included, plus this attempt's.
  let charged = 0;
  const costAfter = () => (imaging ? costOf(events) + charged : run.costMicros);
  // An earlier attempt finished the tool and logged it, and only failed after: its result stands.
  const done = stepEvent(events, "step.finished", step);
  if (done) {
    // Sandbox code a member declined never ran, so there is no time to bill.
    if (gate !== SANDBOX_GATE || (settled && settled.status !== "approved")) return { steps: step, costMicros: costAfter() };
    return await runs.recorded<StepResult>(run.runId, `sandbox-${step}`) ?? billSandbox(run, writer, events, step, done.ms);
  }

  const held = gate ? heldBack(gate, settled, await seenBy(run, taint), room) : null;
  const sandboxed = gate === SANDBOX_GATE && !held;
  if (sandboxed) await threadsRepo().addTaint(run.roomId, run.number, ["sandbox"]);
  const before = stepEvent(events, "step.started", step);
  const detail = toolDetail(call, room);
  const started = before ?? await writer.append({ type: "step.started", step, call, detail });
  if (gate && !held) await auditTool(run, started, call.name, detail);
  const currentStep = run.helper ? `${run.agent.name} › ${call.name}` : call.name;
  await notifyRun(run.roomId, await runs.progress(run, { steps: step, currentStep }), started.seq);
  const t0 = Date.now();
  const bill = ({ usage, costMicros }: { usage: TokenUsage; costMicros: number }) => {
    charged = costMicros;
    const meter = { model: IMAGE_MODEL, job: "image" as const, toolStep: step };
    return recordCall(run, writer, meter, { type: "usage", ...usage, costMicros }, { costMicros: costAfter() });
  };
  const result: Outcome = held
    ? { ok: false, output: held }
    : imaging
      ? await generateImageStep(run, step, call.input, events, imageDeps(bill))
      : await runCall(run, call, offered, step, { room, settled, started, rerun: !!before, envOf, taint });
  const { output, ok, synced, sources, image } = result;
  const ms = result.ms ?? Date.now() - t0;
  if (synced && hasChanges(synced) && !stepEvent(events, "files.synced", step)) await writer.append({ type: "files.synced", step, ...synced });
  const finished = await writer.append({
    type: "step.finished", step, output, ms, ok, ...(sources && { sources }), ...(image && { image }),
  });
  await notifyRun(run.roomId, await runs.stepDone(run), finished.seq);
  return sandboxed ? billSandbox(run, writer, events, step, ms) : { steps: step, costMicros: costAfter() };
}
