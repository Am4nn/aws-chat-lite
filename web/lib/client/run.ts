import type { Message, RunEndStatus, RunEvent } from "../types";
import { keyOf, type PendingMessage } from "./timeline";

export type RunItem =
  | { kind: "step"; step: number; name: string; detail: string; status: "running" | "done" | "failed"; output?: string; ms?: number; startedAt: string }
  | { kind: "steer"; messageSeq: number; authorName: string; text: string; at: string };

export type RunView = {
  lastSeq: number;
  status: "running" | RunEndStatus;
  reason?: string;
  items: RunItem[];
  text: string;
  costMicros: number;
  model?: string;
  startedAt?: string;
  endedAt?: string;
};

export const emptyRun = (): RunView => ({ lastSeq: 0, status: "running", items: [], text: "", costMicros: 0 });

export function applyRunEvent(v: RunView, e: RunEvent): RunView {
  if (e.seq <= v.lastSeq) return v;
  const next = { ...v, lastSeq: e.seq };
  switch (e.type) {
    case "run.started":
      return { ...next, model: e.model, startedAt: e.at };
    case "steer":
      return { ...next, items: [...v.items, { kind: "steer", messageSeq: e.messageSeq, authorName: e.authorName, text: e.text, at: e.at }] };
    case "text":
      return { ...next, text: v.text + e.text };
    case "step.started":
      return { ...next, items: [...v.items, { kind: "step", step: e.step, name: e.call.name, detail: e.detail, status: "running", startedAt: e.at }] };
    case "step.finished":
      return {
        ...next,
        items: v.items.map((i) =>
          i.kind === "step" && i.step === e.step ? { ...i, status: e.ok ? "done" : "failed", output: e.output, ms: e.ms } : i,
        ),
      };
    case "usage":
      return { ...next, model: e.model, costMicros: v.costMicros + e.costMicros };
    case "run.finished":
      return { ...next, status: e.status, reason: e.reason, costMicros: e.costMicros, endedAt: e.at };
  }
}

export type RunRow =
  | { kind: "step"; key: string; step: Extract<RunItem, { kind: "step" }> }
  | {
    kind: "steer"; key: string; text: string; state: "read" | "queued" | "sending" | "failed";
    authorName?: string; at?: string; clientId?: string;
  };

/**
 * What a run shows under its trigger: steps and the steers the loop has read, in event order, then the steers it
 * hasn't read yet, then the ones still being sent. A steer keeps its message's key through all three states, so its
 * row changes in place instead of leaving one list and entering another.
 */
export function runRows(v: RunView, steers: Message[], pending: PendingMessage[]): RunRow[] {
  const bySeq = new Map(steers.map((m) => [m.seq, m]));
  const read = new Set<number>();
  const rows: RunRow[] = v.items.map((i) => {
    if (i.kind === "step") return { kind: "step", key: `step:${i.step}`, step: i };
    read.add(i.messageSeq);
    return { kind: "steer", key: keyOf(bySeq.get(i.messageSeq) ?? { seq: i.messageSeq }), text: i.text, authorName: i.authorName, at: i.at, state: "read" };
  });
  for (const m of steers) {
    if (!read.has(m.seq)) rows.push({ kind: "steer", key: keyOf(m), text: m.text, authorName: m.authorName, state: "queued" });
  }
  for (const p of pending) {
    rows.push({ kind: "steer", key: keyOf(p), text: p.text, clientId: p.clientId, state: p.failed ? "failed" : "sending" });
  }
  return rows;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const stepsLabel = (steps: number, steers: number) =>
  [steps || !steers ? plural(steps, "step") : "", steers ? plural(steers, "steer") : ""].filter(Boolean).join(" · ");
