import type { Budget, Message, RunEndStatus, ThreadStatus, ThreadSummary } from "../types";
import { formatElapsed } from "./format";

const IDLE_ARCHIVE_MS = 7 * 24 * 3600_000;

/** A run is live while it works and while it waits on a member: either way it will still write. */
export const isLive = (status: ThreadStatus) => status === "running" || status === "waiting";

// A live run past the server's deadAt died without closing, and the server already reads it as failed. A waiting run's
// deadAt lies past its approval's expiry, which would have woken it.
const deadAt = (t: ThreadSummary) => Date.parse(t.deadAt ?? "");
const isDead = (t: ThreadSummary, nowMs: number) => isLive(t.status) && nowMs >= deadAt(t);

/** The threads as of `nowMs`: a run that outlived its deadAt reads as failed, so it stops showing live and can archive. */
export const settleDeadRuns = (list: ThreadSummary[], nowMs: number): ThreadSummary[] =>
  list.map((t) => (isDead(t, nowMs) ? { ...t, status: "failed" } : t));

/** When the next live run reaches its deadAt (Infinity when none will), so the list can be settled again then. */
export const nextRunDeadline = (list: ThreadSummary[], nowMs: number) =>
  Math.min(...list.filter((t) => isLive(t.status) && !isDead(t, nowMs)).map(deadAt).filter(Number.isFinite));

/** Budget frames can arrive out of order, so spend never goes back within a month; a new month starts over. */
export function mergeBudget(prev: Budget, next: Budget): Budget {
  if (next.month !== prev.month) return next.month > prev.month ? next : prev;
  // A view of the room read before the owner changed the cap can land after the change; its cap is older, so it loses.
  const cap = next.capRev >= prev.capRev ? next : prev;
  return { ...next, capMicros: cap.capMicros, capRev: cap.capRev, spentMicros: Math.max(prev.spentMicros, next.spentMicros) };
}

export function applyThreadUpdate(list: ThreadSummary[], t: ThreadSummary): ThreadSummary[] {
  const i = list.findIndex((x) => x.threadId === t.threadId);
  if (i < 0) return [...list, t];
  if (list[i].rev >= t.rev) return list;
  return list.map((x, j) => (j === i ? t : x));
}

// The server derives `archived` on read, so a thread that goes idle while the page is open is hidden here too.
export const sidebarThreads = (list: ThreadSummary[], nowMs: number) =>
  list
    .filter((t) => !t.archived && (isLive(t.status) || nowMs - Date.parse(t.lastActivityAt) < IDLE_ARCHIVE_MS))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

export const liveCount = (list: ThreadSummary[]) => list.filter((t) => isLive(t.status)).length;

const ENDED: Record<RunEndStatus, string> = { done: "Done", stopped: "Stopped", failed: "Failed", capped: "Budget reached" };

/** What the run is doing now, or how it ended. */
export function runLabel(t: ThreadSummary): string {
  if (t.status === "running") return t.currentStep ?? "thinking";
  if (t.status === "waiting") return "Needs approval";
  return t.status === "idle" ? "" : ENDED[t.status];
}

/** A thread's state in words, for screen readers; a thread that never ran has none. */
export const stateText = (status: ThreadStatus) =>
  status === "idle" ? "" : status === "running" ? "running" : status === "waiting" ? "needs approval" : ENDED[status].toLowerCase();

/** How long the run has taken: so far while it is live, in total once it ended. */
export function runElapsed(t: ThreadSummary, nowMs: number): string {
  const from = t.startedAt ? Date.parse(t.startedAt) : nowMs;
  const to = isLive(t.status) || !t.endedAt ? nowMs : Date.parse(t.endedAt);
  return formatElapsed(to - from);
}

/** The step count and time, as the run's progress while it is live and its totals once it ended. */
export function runMeta(t: ThreadSummary, nowMs: number): string {
  if (isLive(t.status)) return `step ${Math.max(1, t.steps)} · ${runElapsed(t, nowMs)}`;
  return `${t.steps} ${t.steps === 1 ? "step" : "steps"} · ${runElapsed(t, nowMs)}`;
}

/** A name as it's typed: what the server would refuse never appears, so only the length or a missing letter can fail. */
export const slugName = (typed: string) =>
  typed.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").slice(0, 32);

export function threadMeta(t: ThreadSummary, nowMs: number, timeZone?: string): { text: string; tone: "live" | "waiting" | "muted" } {
  if (t.status === "running") return { text: runMeta(t, nowMs), tone: "live" };
  if (t.status === "waiting") return { text: "needs you", tone: "waiting" };
  if (t.status === "capped") return { text: "budget", tone: "muted" };
  if (t.status === "stopped" || t.status === "failed") return { text: t.status, tone: "muted" };
  const at = new Date(t.endedAt ?? t.lastActivityAt);
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  if (day(at) === day(new Date(nowMs))) {
    return { text: at.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }), tone: "muted" };
  }
  return { text: at.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" }), tone: "muted" };
}

type Block =
  | { kind: "message"; message: Message }
  | { kind: "run"; trigger: Message; steers: Message[]; answer?: Message };

/**
 * `runFirstSeq` is the thread's active or last run. Its trigger opens a run block even once the run has ended,
 * because the answer that closes the block can arrive after the thread says the run is over.
 */
export function groupThread(messages: Message[], runFirstSeq?: number): Block[] {
  const answers = new Map<number, Message>();
  for (const m of messages) if (m.agent) answers.set(m.agent.firstSeq, m);

  const blocks: Block[] = [];
  let open: Extract<Block, { kind: "run" }> | undefined;
  for (const m of messages) {
    if (open && m === open.answer) {
      open = undefined;
    } else if (open) {
      open.steers.push(m);
    } else if (answers.get(m.seq) || m.seq === runFirstSeq) {
      open = { kind: "run", trigger: m, steers: [], answer: answers.get(m.seq) };
      blocks.push(open);
    } else {
      blocks.push({ kind: "message", message: m });
    }
  }
  return blocks;
}
