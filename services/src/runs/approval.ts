import { wakeRun } from "../approvals/decide.js";
import { approvalsRepo, type Approval } from "../approvals/repo.js";
import { auditRepo } from "../audit/repo.js";
import { connectionsRepo } from "../connections/repo.js";
import type { ToolCall } from "../models/gateway.js";
import { findTool, toolEnv } from "../tools/index.js";
import { repoOf } from "../tools/github/repo.js";
import { threadsRepo } from "../threads/repo.js";
import type { ApprovalStatus } from "../threads/types.js";
import { DEAD_AFTER_MS } from "./model.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { limitsReached, models } from "./steps.js";
import { mayRun } from "./tools.js";

/*
 * The steps around a tool call's wait for a member. Everything the wait depends on is read inside a step, so a
 * replay of the run sees the same values.
 */

type Gate = { asks: false } | { asks: true; timeoutSec: number; title: string; input: Record<string, unknown> };

/**
 * Whether a call waits for a member's approval. A write always does. So does a web call in a thread that holds private
 * content, since text injected into that content could have the model carry it out in a URL or a search query. Only a
 * call the run may make, whose input passes the tool's own check (so a repo outside the connection is refused before
 * anyone is asked), asks; a run that must end anyway asks no one. A GitHub call's repo is pinned here, so the write
 * runs on the repo the card named even if the connection changes during the wait. `tainted` is the taint the model's
 * turn saw, which the thread's own can lag behind.
 */
export async function gateOf(run: Run & { model: string }, call: ToolCall, tainted: boolean): Promise<Gate> {
  const tool = findTool(call.name);
  if (!tool || !mayRun(run.model, models().servedBy(run.model), call.name)) return { asks: false };
  const privateThread = async () => tainted || !!(await threadsRepo().threadById(run.roomId, run.threadId))?.taint.length;
  if (!(tool.write || (tool.kind === "web" && await privateThread())) || await limitsReached(run)) return { asks: false };
  const { github, approvalTimeoutSec } = await connectionsRepo().get(run.roomId);
  const env = await toolEnv(process.env.TOOL_MODE, github ?? undefined);
  if (tool.check?.(call.input, env)) return { asks: false };
  const input = tool.kind === "github" ? { ...call.input, repo: repoOf(call.input, github ?? undefined) } : call.input;
  return { asks: true, timeoutSec: approvalTimeoutSec, title: tool.ask!(input, env), input };
}

/**
 * The wait's submitter: stores the approval with the input the gate pinned, logs it once and shows the thread as
 * waiting. A retried submitter is handed the same callback; it finds the approval already decided, or the run
 * already asked to stop, and then wakes the wait itself, since nothing else will.
 */
export async function requestApproval(
  run: Run, call: ToolCall, step: number, gate: { timeoutSec: number; title: string; input: Record<string, unknown> }, callbackId: string,
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
  const requested = (await runs.allEvents(run.runId)).find((e) => e.type === "approval.requested" && e.step === step)
    ?? await (await runs.eventWriter(run.runId)).append({ type: "approval.requested", step, call: item.call, title, expiresAt });
  const deadAt = new Date(Date.parse(expiresAt) + DEAD_AFTER_MS).toISOString();
  const { thread, stopRequestedBy } = await runs.markWaiting(run, { step, title, expiresAt }, deadAt);
  await notifyRun(run.roomId, thread, requested.seq);
  if (stopRequestedBy && await approvals.cancel(run.runId, step, stopRequestedBy)) await wakeRun(callbackId);
}

/**
 * Once the wait is over, by a decision, a stop or the timeout: the approval item says which (one still pending
 * expires now). It is logged and audited once, and the thread goes back to running.
 */
export async function settleApproval(run: Run, step: number): Promise<Approval> {
  const runs = runsRepo();
  const item = await approvalsRepo().settle(run.runId, step);
  const decision = item.status as Exclude<ApprovalStatus, "pending">;
  const settled = (await runs.allEvents(run.runId)).find((e) => e.type === "approval.settled" && e.step === step)
    ?? await (await runs.eventWriter(run.runId)).append({ type: "approval.settled", step, decision, by: item.by });
  await auditRepo().record(run.roomId, {
    id: `${run.runId}#${settled.seq}`, at: settled.at, actor: item.by ?? "agent", kind: decision, threadNumber: run.number,
    tool: item.call.name, detail: item.title,
  });
  const thread = await runs.doneWaiting(run, step, Date.now() - Date.parse(item.requestedAt));
  await notifyRun(run.roomId, thread, settled.seq);
  return item;
}
