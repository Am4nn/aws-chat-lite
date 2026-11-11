import type { Message, RunEndStatus, ThreadSummary } from "../types";
import { formatElapsed } from "./format";

const IDLE_ARCHIVE_MS = 7 * 24 * 3600_000;

export function applyThreadUpdate(list: ThreadSummary[], t: ThreadSummary): ThreadSummary[] {
  const i = list.findIndex((x) => x.threadId === t.threadId);
  if (i < 0) return [...list, t];
  if (list[i].rev >= t.rev) return list;
  return list.map((x, j) => (j === i ? t : x));
}

// The server derives `archived` on read, so a thread that goes idle while the page is open is hidden here too.
export const sidebarThreads = (list: ThreadSummary[], nowMs: number) =>
  list
    .filter((t) => !t.archived && (t.status === "running" || nowMs - Date.parse(t.lastActivityAt) < IDLE_ARCHIVE_MS))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

export const liveCount = (list: ThreadSummary[]) => list.filter((t) => t.status === "running").length;

const ENDED: Record<RunEndStatus, string> = { done: "Done", stopped: "Stopped", failed: "Failed", capped: "Budget reached" };

/** What the run is doing now, or how it ended. */
export function runLabel(t: ThreadSummary): string {
  if (t.status === "running") return t.currentStep ?? "thinking";
  return t.status === "idle" ? "" : ENDED[t.status];
}

/** How long the run has taken: so far while it runs, in total once it ended. */
export function runElapsed(t: ThreadSummary, nowMs: number): string {
  const from = t.startedAt ? Date.parse(t.startedAt) : nowMs;
  const to = t.status === "running" || !t.endedAt ? nowMs : Date.parse(t.endedAt);
  return formatElapsed(to - from);
}

/** The step count and time, as the run's progress while it runs and its totals once it ended. */
export function runMeta(t: ThreadSummary, nowMs: number): string {
  if (t.status === "running") return `step ${Math.max(1, t.steps)} · ${runElapsed(t, nowMs)}`;
  return `${t.steps} ${t.steps === 1 ? "step" : "steps"} · ${runElapsed(t, nowMs)}`;
}

/** A name as it's typed: what the server would refuse never appears, so only the length or a missing letter can fail. */
export const slugName = (typed: string) =>
  typed.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").slice(0, 32);

export function threadMeta(t: ThreadSummary, nowMs: number, timeZone?: string): { text: string; tone: "live" | "muted" } {
  if (t.status === "running") return { text: runMeta(t, nowMs), tone: "live" };
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
