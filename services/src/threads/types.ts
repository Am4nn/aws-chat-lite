export type RunEndStatus = "done" | "stopped" | "failed" | "capped";
export type ThreadStatus = "idle" | "running" | RunEndStatus;

export type ThreadSummary = {
  roomId: string;
  threadId: string;
  number: number;
  name: string;
  status: ThreadStatus;
  /** Incremented on every write; clients keep the highest. */
  rev: number;
  runId?: string;
  runFirstSeq?: number;
  startedAt?: string;
  endedAt?: string;
  steps: number;
  currentStep?: string;
  costMicros: number;
  summary?: string;
  createdBy: string;
  lastActivityAt: string;
  /** Derived on read, never stored. */
  archived: boolean;
};

export type Budget = { spentMicros: number; capMicros: number; month: string; resetsAt: string };

export type RunEventBody =
  | { type: "run.started"; model: string; startedBy: string }
  | { type: "steer"; messageSeq: number; authorName: string; text: string }
  /** `turn` is the model call that wrote it (the loop's `model-<turn>` step). */
  | { type: "text"; text: string; turn: number }
  /** An attempt at `turn` failed after writing text, and the retry answers again: that turn's text so far is void. */
  | { type: "text.reset"; turn: number }
  | { type: "step.started"; step: number; call: { id: string; name: string; input: Record<string, unknown> }; detail: string }
  | { type: "step.finished"; step: number; output: string; ms: number; ok: boolean }
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number; costMicros: number }
  | { type: "run.finished"; status: RunEndStatus; reason?: string; ms: number; steps: number; costMicros: number };

export type RunEvent = RunEventBody & { seq: number; at: string };
