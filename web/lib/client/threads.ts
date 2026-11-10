import type { Message, ThreadSummary } from "../types";
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

export function threadMeta(t: ThreadSummary, nowMs: number, timeZone?: string): { text: string; tone: "live" | "muted" } {
  if (t.status === "running") {
    const elapsed = t.startedAt ? formatElapsed(nowMs - Date.parse(t.startedAt)) : "0:00";
    return { text: `step ${t.steps} · ${elapsed}`, tone: "live" };
  }
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

export function groupThread(messages: Message[], thread?: ThreadSummary): Block[] {
  const answers = new Map<number, Message>();
  for (const m of messages) if (m.agent) answers.set(m.agent.firstSeq, m);
  const liveFirstSeq = thread?.status === "running" ? thread.runFirstSeq : undefined;

  const blocks: Block[] = [];
  let open: Extract<Block, { kind: "run" }> | undefined;
  for (const m of messages) {
    if (open && m === open.answer) {
      open = undefined;
    } else if (open) {
      open.steers.push(m);
    } else if (answers.get(m.seq) || m.seq === liveFirstSeq) {
      open = { kind: "run", trigger: m, steers: [], answer: answers.get(m.seq) };
      blocks.push(open);
    } else {
      blocks.push({ kind: "message", message: m });
    }
  }
  return blocks;
}
