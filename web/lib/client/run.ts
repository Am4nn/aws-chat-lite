import type { ApprovalStatus, FilesSynced, Message, ModelPick, RunEndStatus, RunEvent, Source } from "../types";
import { keyOf, type PendingMessage } from "./timeline";

export type RunItem =
  | { kind: "step"; step: number; name: string; detail: string; status: "running" | "done" | "failed"; output?: string; ms?: number; startedAt: string; files?: FilesSynced }
  | { kind: "steer"; messageSeq: number; authorName: string; text: string; at: string }
  | {
    kind: "approval"; step: number; title: string; call: { id: string; name: string; input: Record<string, unknown> }; expiresAt: string;
    status: ApprovalStatus; by?: string;
    /** Approved, but the run was stopped before the call's step began, so it never ran. */
    stoppedFirst?: true;
  };

export type ApprovalItem = Extract<RunItem, { kind: "approval" }>;

export type RunView = {
  lastSeq: number;
  status: "running" | RunEndStatus;
  reason?: string;
  items: RunItem[];
  text: string;
  /** What the run's web tools read, once per url, in the order they came. */
  sources: Source[];
  /** Where the newest model turn's text starts in `text`, so a reset of that turn can cut it back out. */
  turnStart?: { turn: number; at: number };
  costMicros: number;
  pick?: ModelPick;
  model?: string;
  startedAt?: string;
  endedAt?: string;
};

export const emptyRun = (): RunView => ({ lastSeq: 0, status: "running", items: [], text: "", sources: [], costMicros: 0 });

export function applyRunEvent(v: RunView, e: RunEvent): RunView {
  if (e.seq <= v.lastSeq) return v;
  const next = { ...v, lastSeq: e.seq };
  switch (e.type) {
    case "run.started":
      return { ...next, pick: e.pick, startedAt: e.at };
    case "routed":
      return { ...next, model: e.model };
    case "model.turn":
      return next;
    case "steer":
      return { ...next, items: [...v.items, { kind: "steer", messageSeq: e.messageSeq, authorName: e.authorName, text: e.text, at: e.at }] };
    case "text": {
      const turnStart = v.turnStart?.turn === e.turn ? v.turnStart : { turn: e.turn, at: v.text.length };
      return { ...next, text: v.text + e.text, turnStart };
    }
    case "text.reset":
      return v.turnStart?.turn === e.turn ? { ...next, text: v.text.slice(0, v.turnStart.at) } : next;
    case "step.started":
      return { ...next, items: [...v.items, { kind: "step", step: e.step, name: e.call.name, detail: e.detail, status: "running", startedAt: e.at }] };
    case "step.finished": {
      const sources = [...v.sources];
      for (const s of e.sources ?? []) if (!sources.some((x) => x.url === s.url)) sources.push(s);
      return {
        ...next,
        items: v.items.map((i) =>
          i.kind === "step" && i.step === e.step ? { ...i, status: e.ok ? "done" : "failed", output: e.output, ms: e.ms } : i,
        ),
        sources,
      };
    }
    case "approval.requested":
      return {
        ...next,
        items: [...v.items, { kind: "approval", step: e.step, title: e.title, call: e.call, expiresAt: e.expiresAt, status: "pending" }],
      };
    case "approval.settled":
      return {
        ...next,
        items: v.items.map((i) => (i.kind === "approval" && i.step === e.step ? { ...i, status: e.decision, by: e.by } : i)),
      };
    case "files.synced":
      return {
        ...next,
        items: v.items.map((i) =>
          i.kind === "step" && i.step === e.step ? { ...i, files: { written: e.written, deleted: e.deleted, notes: e.notes } } : i,
        ),
      };
    case "usage":
      return { ...next, costMicros: v.costMicros + e.costMicros };
    case "run.finished": {
      const ran = (step: number) => v.items.some((i) => i.kind === "step" && i.step === step);
      const items = e.status !== "stopped" ? v.items : v.items.map((i) =>
        i.kind === "approval" && i.status === "approved" && !ran(i.step) ? { ...i, stoppedFirst: true as const } : i,
      );
      return { ...next, items, status: e.status, reason: e.reason, costMicros: e.costMicros, endedAt: e.at };
    }
  }
}

export type RunRow =
  | { kind: "step"; key: string; step: Extract<RunItem, { kind: "step" }> }
  | { kind: "approval"; key: string; approval: ApprovalItem }
  | {
    kind: "steer"; key: string; text: string; state: "read" | "queued" | "unread" | "sending" | "failed";
    authorName?: string; at?: string; clientId?: string;
  };

/**
 * What a run shows under its trigger: steps and the steers the loop has read, in event order, then the steers it
 * hasn't read yet (queued while it runs, unread once it ended without them), then the ones still being sent. A steer
 * keeps its message's key through every state, so its row changes in place instead of leaving one list and entering another.
 */
export function runRows(v: RunView, steers: Message[], pending: PendingMessage[]): RunRow[] {
  const waiting = v.status === "running" ? "queued" : "unread";
  const bySeq = new Map(steers.map((m) => [m.seq, m]));
  const read = new Set<number>();
  const rows: RunRow[] = v.items.map((i) => {
    if (i.kind === "step") return { kind: "step", key: `step:${i.step}`, step: i };
    if (i.kind === "approval") return { kind: "approval", key: `approval:${i.step}`, approval: i };
    read.add(i.messageSeq);
    return { kind: "steer", key: keyOf(bySeq.get(i.messageSeq) ?? { seq: i.messageSeq }), text: i.text, authorName: i.authorName, at: i.at, state: "read" };
  });
  for (const m of steers) {
    if (!read.has(m.seq)) rows.push({ kind: "steer", key: keyOf(m), text: m.text, authorName: m.authorName, state: waiting });
  }
  for (const p of pending) {
    rows.push({ kind: "steer", key: keyOf(p), text: p.text, clientId: p.clientId, state: p.failed ? "failed" : "sending" });
  }
  return rows;
}

/**
 * A sandbox step's output ends with what it did to the room's files, the lines the model read. Split off, the run view
 * can show them apart from what the code printed.
 */
export function splitSyncLines(output: string, files: FilesSynced): { output: string; lines: string[] } {
  const lines = [
    ...(files.written.length ? [`Saved to room files: ${files.written.join(", ")}`] : []),
    ...(files.deleted.length ? [`Deleted from room files: ${files.deleted.join(", ")}`] : []),
    ...files.notes,
  ];
  const tail = `\n${lines.join("\n")}`;
  return lines.length && output.endsWith(tail) ? { output: output.slice(0, -tail.length), lines } : { output, lines: [] };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const stepsLabel = (steps: number, steers: number) =>
  [steps || !steers ? plural(steps, "step") : "", steers ? plural(steers, "steer") : ""].filter(Boolean).join(" · ");
