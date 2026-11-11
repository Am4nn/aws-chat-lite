import type { ApprovalStatus, FilesSynced, Message, ModelPick, RunEndStatus, RunEvent, Source } from "../types";
import { keyOf, type PendingMessage } from "./timeline";

export type RunItem =
  | {
    kind: "step"; step: number; name: string; detail: string; status: "running" | "done" | "failed"; output?: string; ms?: number; startedAt: string;
    files?: FilesSynced;
    /** A `delegate` step: the helper agent that does it, and what it does in its own lane. */
    helper?: Helper;
  }
  | { kind: "steer"; messageSeq: number; authorName: string; text: string; at: string }
  | {
    kind: "approval"; step: number; title: string; call: { id: string; name: string; input: Record<string, unknown> }; expiresAt: string;
    status: ApprovalStatus; by?: string;
    /** Approved, but the run was stopped before the call's step began, so it never ran. */
    stoppedFirst?: true;
  };

export type ApprovalItem = Extract<RunItem, { kind: "approval" }>;

/** What one lane of a run shows: its steps, steers and approvals in event order, and its text. */
export type Lane = {
  items: RunItem[];
  text: string;
  /** Where the newest model turn's text starts in `text`, so a reset of that turn can cut it back out. */
  turnStart?: { turn: number; at: number };
};

type Helper = Lane & { lane: number; agentName: string; task: string; status: "running" | RunEndStatus; summary?: string };

export type RunView = Lane & {
  lastSeq: number;
  /** Every event so far, every lane's, in order. */
  events: RunEvent[];
  status: "running" | RunEndStatus;
  reason?: string;
  /** What the run's web tools read, once per url, in the order they came. */
  sources: Source[];
  costMicros: number;
  pick?: ModelPick;
  model?: string;
  startedAt?: string;
  endedAt?: string;
};

export const emptyRun = (): RunView => ({ lastSeq: 0, events: [], status: "running", items: [], text: "", sources: [], costMicros: 0 });

type LaneEvent = Extract<RunEvent, { type: "steer" | "text" | "text.reset" | "step.started" | "step.finished" | "approval.requested" | "approval.settled" | "files.synced" }>;

const withHelper = (items: RunItem[], step: number, change: (h: Helper | undefined) => Helper | undefined) =>
  items.map((i) => (i.kind === "step" && i.step === step ? { ...i, helper: change(i.helper) } : i));

/**
 * Folds one event into the run. The run's own agent (lane 0) makes the top-level rows and the answer; a helper's
 * events go onto the `delegate` step that started it, so its text never mixes into the answer.
 */
export function applyRunEvent(v: RunView, e: RunEvent): RunView {
  if (e.seq <= v.lastSeq) return v;
  const next = { ...v, lastSeq: e.seq, events: [...v.events, e] };
  switch (e.type) {
    case "run.started":
      return { ...next, pick: e.pick, startedAt: e.at };
    case "routed":
      return { ...next, model: e.model };
    case "model.turn":
      return next;
    case "usage":
      return { ...next, costMicros: v.costMicros + e.costMicros };
    case "helper.started":
      return { ...next, items: withHelper(v.items, e.step, () => ({ lane: e.lane ?? 0, agentName: e.agentName, task: e.task, status: "running", items: [], text: "" })) };
    case "helper.finished":
      return { ...next, items: withHelper(v.items, e.step, (h) => h && { ...h, status: e.status, summary: e.summary }) };
    case "run.finished": {
      const ran = (step: number) => v.items.some((i) => i.kind === "step" && i.step === step);
      const items = e.status !== "stopped" ? v.items : v.items.map((i) =>
        i.kind === "approval" && i.status === "approved" && !ran(i.step) ? { ...i, stoppedFirst: true as const } : i,
      );
      return { ...next, items, status: e.status, reason: e.reason, costMicros: e.costMicros, endedAt: e.at };
    }
  }
  const sources = e.type === "step.finished" ? addSources(v.sources, e.sources) : v.sources;
  const lane = e.lane ?? 0;
  if (!lane) return { ...applyToLane(next, e), sources };
  return {
    ...next, sources,
    items: v.items.map((i) => (i.kind === "step" && i.helper?.lane === lane ? { ...i, helper: applyToLane(i.helper, e) } : i)),
  };
}

export function applyToLane<T extends Lane>(v: T, e: LaneEvent): T {
  switch (e.type) {
    case "steer":
      return { ...v, items: [...v.items, { kind: "steer", messageSeq: e.messageSeq, authorName: e.authorName, text: e.text, at: e.at }] };
    case "text": {
      const turnStart = v.turnStart?.turn === e.turn ? v.turnStart : { turn: e.turn, at: v.text.length };
      return { ...v, text: v.text + e.text, turnStart };
    }
    case "text.reset":
      return v.turnStart?.turn === e.turn ? { ...v, text: v.text.slice(0, v.turnStart.at) } : v;
    case "step.started":
      return { ...v, items: [...v.items, { kind: "step", step: e.step, name: e.call.name, detail: e.detail, status: "running", startedAt: e.at }] };
    case "step.finished":
      return {
        ...v,
        items: v.items.map((i) => (i.kind === "step" && i.step === e.step ? { ...i, status: e.ok ? "done" : "failed", output: e.output, ms: e.ms } : i)),
      };
    case "approval.requested":
      return { ...v, items: [...v.items, { kind: "approval", step: e.step, title: e.title, call: e.call, expiresAt: e.expiresAt, status: "pending" }] };
    case "approval.settled":
      return { ...v, items: v.items.map((i) => (i.kind === "approval" && i.step === e.step ? { ...i, status: e.decision, by: e.by } : i)) };
    case "files.synced":
      return {
        ...v,
        items: v.items.map((i) =>
          i.kind === "step" && i.step === e.step ? { ...i, files: { written: e.written, deleted: e.deleted, notes: e.notes } } : i,
        ),
      };
  }
}

function addSources(sources: Source[], found: Source[] = []): Source[] {
  const all = [...sources];
  for (const s of found) if (!all.some((x) => x.url === s.url)) all.push(s);
  return all;
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
 * A helper's approvals follow its delegate step, so a write it waits on is in view, not folded away inside the step.
 */
export function runRows(v: RunView, steers: Message[], pending: PendingMessage[]): RunRow[] {
  const waiting = v.status === "running" ? "queued" : "unread";
  const bySeq = new Map(steers.map((m) => [m.seq, m]));
  const read = new Set<number>();
  const approvalRow = (a: ApprovalItem): RunRow => ({ kind: "approval", key: `approval:${a.step}`, approval: a });
  const rows: RunRow[] = v.items.flatMap((i): RunRow[] => {
    if (i.kind === "step") {
      const asked = i.helper?.items.filter((h) => h.kind === "approval") ?? [];
      return [{ kind: "step", key: `step:${i.step}`, step: i }, ...asked.map(approvalRow)];
    }
    if (i.kind === "approval") return [approvalRow(i)];
    read.add(i.messageSeq);
    return [{ kind: "steer", key: keyOf(bySeq.get(i.messageSeq) ?? { seq: i.messageSeq }), text: i.text, authorName: i.authorName, at: i.at, state: "read" }];
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
