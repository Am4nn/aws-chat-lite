import type { ModelPick, TokenUsage } from "../models/catalog.js";
import type { TaintSource } from "../models/privacy.js";
import type { FilesSynced } from "../workspace/types.js";

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
  /** Why the thread is private, sorted; [] while it has no private content. */
  taint: TaintSource[];
  summary?: string;
  createdBy: string;
  lastActivityAt: string;
  /** Derived on read, never stored. */
  archived: boolean;
};

export type Budget = { spentMicros: number; capMicros: number; month: string; resetsAt: string };

export type RunEventBody =
  | { type: "run.started"; pick: ModelPick; startedBy: string }
  /** Once per run, before its first model call: the model id that answers. */
  | { type: "routed"; model: string; by: "pick" | "default" | "auto" }
  /** The provider's own content for a model call that ended, replayed verbatim on the next call; never streamed. */
  | { type: "model.turn"; model: string; content: unknown }
  | { type: "steer"; messageSeq: number; authorName: string; text: string }
  | { type: "text"; text: string }
  | { type: "step.started"; step: number; call: { id: string; name: string; input: Record<string, unknown> }; detail: string }
  | { type: "step.finished"; step: number; output: string; ms: number; ok: boolean }
  /** What a sandbox step saved to or deleted from the room's files, and what it couldn't. */
  | ({ type: "files.synced"; step: number } & FilesSynced)
  /** Sandbox time is billed as `model: "sandbox"` with no tokens. */
  | ({ type: "usage"; model: string; job: "route" | "name" | "run" | "sandbox"; costMicros: number } & TokenUsage)
  | { type: "run.finished"; status: RunEndStatus; reason?: string; ms: number; steps: number; costMicros: number };

export type RunEvent = RunEventBody & { seq: number; at: string };
