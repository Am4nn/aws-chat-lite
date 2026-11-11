import type { Message, ModelPick, RunEndStatus, RunEvent } from "../types";

type RunItem =
  | { kind: "step"; step: number; name: string; detail: string; status: "running" | "done" | "failed"; output?: string; ms?: number; startedAt: string }
  | { kind: "steer"; messageSeq: number; authorName: string; text: string; at: string };

type RunView = {
  lastSeq: number;
  status: "running" | RunEndStatus;
  reason?: string;
  items: RunItem[];
  text: string;
  costMicros: number;
  pick?: ModelPick;
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
      return { ...next, pick: e.pick, startedAt: e.at };
    case "routed":
      return { ...next, model: e.model };
    case "model.turn":
      return next;
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
      return { ...next, costMicros: v.costMicros + e.costMicros };
    case "run.finished":
      return { ...next, status: e.status, reason: e.reason, costMicros: e.costMicros, endedAt: e.at };
  }
}

export function queuedSteers(v: RunView, steers: Message[]): Message[] {
  const read = new Set(v.items.flatMap((i) => (i.kind === "steer" ? [i.messageSeq] : [])));
  return steers.filter((m) => !read.has(m.seq));
}
