import { wakeRun } from "../approvals/decide.js";
import { approvalsRepo, type Approval } from "../approvals/repo.js";
import { auditRepo } from "../audit/repo.js";
import { budgetRepo } from "../budget/repo.js";
import type { ToolCall } from "../models/gateway.js";
import { enqueuePush } from "../push/enqueue.js";
import { isPrivate, mergeTaint, type TaintSource } from "../models/privacy.js";
import { findTool, toolEnv } from "../tools/index.js";
import { repoOf } from "../tools/github/repo.js";
import { threadsRepo } from "../threads/repo.js";
import type { ApprovalStatus } from "../threads/types.js";
import { stepEvent } from "./context.js";
import { DEAD_AFTER_MS } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo } from "./repo.js";
import { laneOf, limitsReached, models, roomConnections, toolRoom, type RoutedRun } from "./steps.js";
import { asksFirst, mayRun, runGate } from "./tools.js";

/*
 * The steps around a tool call's wait for a member. Everything the wait depends on is read inside a step, so a
 * replay of the run sees the same values.
 */

type Gate = { asks: false } | { asks: true; timeoutSec: number; title: string; input: Record<string, unknown> };

/**
 * Whether a call waits for a member's approval, as `asksFirst` rules under the room's mode. Only a call the run may
 * make, whose input passes the tool's own check (so a repo outside the connection is refused before anyone is asked),
 * asks; a run that must end anyway asks no one. A GitHub call's repo is pinned here, so the write runs on the repo the
 * card named even if the connection changes during the wait. `taint` is what the model's turn saw, which the thread's
 * own can lag behind. A tool that asks only because of the floor, a GitHub read, has no title of its own.
 */
export async function gateOf(run: RoutedRun, call: ToolCall, taint: TaintSource[]): Promise<Gate> {
  const room = await roomConnections(run.roomId);
  const tool = runGate(call.name) ?? findTool(call.name, room);
  if (!tool || !mayRun(run.model, models().servedBy(run.model), call.name, room, run.agent.tools)) return { asks: false };
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  const seen = mergeTaint(taint, thread?.taint ?? []);
  const rules = { mode: room.approvalMode, sandboxInternet: room.sandboxInternet };
  if (!asksFirst(tool, seen, rules) || await limitsReached(run)) return { asks: false };
  const { github, approvalTimeoutSec } = room;
  const env = { ...await toolEnv(process.env.TOOL_MODE, github ?? undefined), room: toolRoom(run, isPrivate(seen)) };
  if ("check" in tool && tool.check?.(call.input, env)) return { asks: false };
  const input = tool.kind === "github" ? { ...call.input, repo: repoOf(call.input, github ?? undefined) } : call.input;
  return { asks: true, timeoutSec: approvalTimeoutSec, title: tool.ask?.(input, env) ?? `Run ${call.name}?`, input };
}

/**
 * The wait's submitter: stores the approval with the input the gate pinned, logs it once, shows the thread as
 * waiting and tells the whole room, since any member may approve. A retried submitter is handed the same callback; it
 * finds the approval already decided, or the run already asked to stop, and then wakes the wait itself, since nothing
 * else will. A stop that landed first shows on the run as `markWaiting` wrote it; an archive that landed before the
 * run showed as waiting found no waiting thread to wake, so the run reads the room once it waits. Either way it
 * cancels and wakes its own wait.
 */
export async function requestApproval(
  run: RoutedRun, call: ToolCall, step: number, gate: { timeoutSec: number; title: string; input: Record<string, unknown> }, callbackId: string,
): Promise<void> {
  const runs = runsRepo();
  const approvals = approvalsRepo();
  const asked = { ...call, input: gate.input };
  const item = await approvals.open({
    runId: run.runId, roomId: run.roomId, threadId: run.threadId, step, call: asked, title: gate.title, callbackId,
    expiresAt: new Date(Date.now() + gate.timeoutSec * 1000).toISOString(),
  });
  if (item.status !== "pending") return wakeRun(callbackId);
  const { title, expiresAt } = item;
  const logged = stepEvent(await runs.allEvents(run.runId), "approval.requested", step);
  const requested = logged
    ?? await (await runs.eventWriter(run.runId, laneOf(run))).append({ type: "approval.requested", step, call: item.call, title, expiresAt });
  const deadAt = new Date(Date.parse(expiresAt) + DEAD_AFTER_MS).toISOString();
  const { thread, stopRequestedBy } = await runs.markWaiting(run, { step, title, expiresAt }, deadAt);
  await notifyRun(run.roomId, thread, requested.seq);
  if (!logged) {
    await enqueuePush({ kind: "approval", roomId: run.roomId, threadId: run.threadId, number: run.number, runId: run.runId, step, title });
  }
  const archived = !stopRequestedBy && (await budgetRepo().withArchived(run.roomId, new Date())).archived;
  if ((stopRequestedBy || archived) && await approvals.cancel(run.runId, step, stopRequestedBy)) await wakeRun(callbackId);
}

/**
 * Once the wait is over, by a decision, a stop or the timeout: the approval item says which (one still pending
 * expires now). It is logged and audited once, and the thread goes back to running.
 */
export async function settleApproval(run: RoutedRun, step: number): Promise<Approval> {
  const runs = runsRepo();
  const item = await approvalsRepo().settle(run.runId, step);
  const decision = item.status as Exclude<ApprovalStatus, "pending">;
  const settled = stepEvent(await runs.allEvents(run.runId), "approval.settled", step)
    ?? await (await runs.eventWriter(run.runId, laneOf(run))).append({ type: "approval.settled", step, decision, by: item.by });
  await auditRepo().record(run.roomId, {
    id: `${run.runId}#${settled.seq}`, at: settled.at, actor: item.by ?? "agent", kind: decision, threadNumber: run.number,
    tool: item.call.name, detail: item.title,
  });
  const thread = await runs.doneWaiting(run, step, Date.now() - Date.parse(item.requestedAt));
  await notifyRun(run.roomId, thread, settled.seq);
  return item;
}
