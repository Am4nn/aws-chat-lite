import type { ToolCall } from "../models/gateway.js";
import type { ModelPick, TokenUsage } from "../models/catalog.js";
import type { TaintSource } from "../models/privacy.js";
import type { FilesSynced } from "../workspace/types.js";

export type RunEndStatus = "done" | "stopped" | "failed" | "capped";
export type ThreadStatus = "idle" | "running" | "waiting" | RunEndStatus;

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
  /** Past this a run still marked running is dead; unset on threads from before runs had one. */
  deadAt?: string;
  steps: number;
  currentStep?: string;
  costMicros: number;
  /** The model the latest run answers on, once it has routed. */
  model?: string;
  /** Why the thread is private, sorted; [] while it has no private content. */
  taint: TaintSource[];
  summary?: string;
  /** Set while status is "waiting". */
  approval?: { step: number; title: string; expiresAt: string };
  createdBy: string;
  lastActivityAt: string;
  /** Derived on read, never stored. */
  archived: boolean;
};

export type Source = { title: string; url: string };
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type GitHubConnection = { installationId: number; account: string; repos: string[]; addedBy: string; addedAt: string };
export type Scope = "rooms:read" | "rooms:write";
export type McpToolInfo = { name: string; title?: string; description: string; inputSchema: object; readOnly: boolean };
export type McpConnection = {
  name: string;
  url: string;
  auth: "oauth" | "none";
  status: "connected" | "needs_auth";
  tools: McpToolInfo[];
  /** How many tools the server listed, before the snapshot was capped. */
  toolCount: number;
  toolsAt: string;
  addedBy: string;
  addedAt: string;
};
export type McpApp = { grantId: string; clientName: string; scopes: Scope[]; createdAt: string; lastUsedAt: string };
export type AuditKind = "asked" | "tool" | "approved" | "denied" | "expired" | "cancelled" | "connected" | "disconnected" | "timeout";
export type AuditEntry = { id: string; at: string; actor: string; kind: AuditKind; threadNumber?: number; tool?: string; detail: string };

export type Budget = { spentMicros: number; capMicros: number; month: string; resetsAt: string };

export type RunEventBody =
  | { type: "run.started"; pick: ModelPick; startedBy: string }
  /** Once per run, before its first model call: the model id that answers. */
  | { type: "routed"; model: string; by: "pick" | "default" | "auto" }
  /** The provider's own content for a model call that ended, replayed verbatim on the next call; never streamed. */
  | { type: "model.turn"; model: string; content: unknown; turn: number }
  | { type: "steer"; messageSeq: number; authorName: string; text: string; attachments?: string[] }
  /** `turn` is the model call that wrote it (the loop's `model-<turn>` step). */
  | { type: "text"; text: string; turn: number }
  /** An attempt at `turn` failed after writing, and the retry answers again: that turn's text and native turn are void. */
  | { type: "text.reset"; turn: number }
  | { type: "step.started"; step: number; call: { id: string; name: string; input: Record<string, unknown> }; detail: string }
  | { type: "step.finished"; step: number; output: string; ms: number; ok: boolean; sources?: Source[] }
  /** What a sandbox step saved to or deleted from the room's files, and what it couldn't. */
  | ({ type: "files.synced"; step: number } & FilesSynced)
  | { type: "approval.requested"; step: number; call: ToolCall; title: string; expiresAt: string }
  | { type: "approval.settled"; step: number; decision: Exclude<ApprovalStatus, "pending">; by?: string }
  /** Sandbox time is billed as `model: "sandbox"` with no tokens. */
  | ({ type: "usage"; model: string; job: "route" | "name" | "run" | "sandbox"; costMicros: number } & TokenUsage)
  | { type: "run.finished"; status: RunEndStatus; reason?: string; ms: number; steps: number; costMicros: number };

export type RunEvent = RunEventBody & { seq: number; at: string };
