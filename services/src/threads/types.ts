import type { ToolCall } from "../models/gateway.js";
import type { ModelPick, TokenUsage } from "../models/catalog.js";
import type { TaintSource } from "../models/privacy.js";
import type { FilesSynced } from "../workspace/types.js";
import type { Attachment } from "../chat/model.js";

export type RunEndStatus = "done" | "stopped" | "failed" | "capped";
export type ThreadStatus = "idle" | "running" | "waiting" | RunEndStatus;

export type ThreadSummary = {
  roomId: string;
  threadId: string;
  number: number;
  name: string;
  /** The room agent that answers the thread. */
  agentId: string;
  status: ThreadStatus;
  /** Incremented on every write; clients keep the highest. */
  rev: number;
  runId?: string;
  runFirstSeq?: number;
  startedAt?: string;
  endedAt?: string;
  /** Past this a run still marked running is dead; unset until the thread's first run. */
  deadAt?: string;
  steps: number;
  currentStep?: string;
  costMicros: number;
  /** The model the latest run answers on, once it has routed. */
  model?: string;
  /** What the thread holds, sorted: private content, and `"room"` once it read room chat (not private). */
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
/** `destructive`: absent in a snapshot taken before servers' destructive hints were kept. */
export type McpToolInfo = { name: string; description: string; inputSchema: object; readOnly: boolean; destructive?: boolean };
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
/** How much of what an agent does in a room waits for a member: everything that writes (ask), only the risky (auto), or nothing (bypass). */
export type ApprovalMode = "ask" | "auto" | "bypass";

export type AuditKind = "asked" | "tool" | "approved" | "denied" | "expired" | "cancelled" | "connected" | "disconnected" | "timeout" | "mode" | "cap";
export type AuditEntry = {
  id: string; at: string; actor: string; kind: AuditKind; threadNumber?: number; tool?: string; detail: string;
  /** The agent that made the call or answered the ask. */
  agent?: string;
};

/** What an agent may use: `mcp` stands for all of the room's MCP servers. */
export type ToolKind = "sandbox" | "web" | "github" | "mcp" | "images" | "room_read" | "room_post" | "room_agents";
/** `room` follows the room's default model. */
export type AgentModel = ModelPick | "room";
export type Agent = {
  agentId: string; name: string; instructions: string; tools: ToolKind[]; model: AgentModel;
  builtIn: boolean; createdBy: string; createdByName: string; createdAt: string; updatedAt: string;
  /** Absent means every agent in the room. */
  delegates?: "all" | string[];
  /** Set when an agent made this one; `createdBy` is then the approving member, or "" when the mode needed no card. */
  madeBy?: { agentId: string; name: string };
};
export type MemoryEntry = {
  memoryId: string; text: string; private: boolean;
  source: { kind: "agent"; agent: string; threadNumber: number } | { kind: "member"; username: string };
  createdAt: string; updatedAt: string; updatedBy: string;
};
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Cadence =
  | { kind: "hours"; every: 1 | 2 | 3 | 4 | 6 | 8 | 12; minute: number }
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; day: Weekday; time: string };
export type Schedule = {
  scheduleId: string; agentId: string; title: string; prompt: string; cadence: Cadence; chatId: string;
  enabled: boolean; createdBy: string; createdByName: string; createdAt: string;
  /** Derived on read, for an enabled schedule only. */
  nextAt?: string;
  lastRun?: { at: string; threadNumber?: number; skipped?: string };
};

export type Aspect = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
/** An image a run generated, saved at `path` in the room's files. */
export type GeneratedImage = { path: string; aspect: Aspect };

/** `capRev`: bumped on every cap change, so a client can tell an older view of the cap from the one just set. */
export type Budget = { spentMicros: number; capMicros: number; capRev: number; month: string; resetsAt: string };

export type RunEventBody =
  /** `agentName`: who answers, as named when the run started, so the run reads the same after a rename or a delete. */
  | { type: "run.started"; pick: ModelPick; startedBy: string; agentName: string }
  /** Once per run, before its first model call: the model id that answers. */
  | { type: "routed"; model: string; by: "pick" | "default" | "auto" }
  /** The provider's own content for a model call that ended, replayed verbatim on the next call; never streamed. */
  | { type: "model.turn"; model: string; content: unknown; turn: number }
  /** Attachments are stored without their urls, which expire. */
  | { type: "steer"; messageSeq: number; authorName: string; text: string; attachments?: Attachment[] }
  /** `turn` is the model call that wrote it (the loop's `model-<turn>` step). */
  | { type: "text"; text: string; turn: number }
  /** An attempt at `turn` failed after writing, and the retry answers again: that turn's text and native turn are void. */
  | { type: "text.reset"; turn: number }
  | { type: "step.started"; step: number; call: { id: string; name: string; input: Record<string, unknown> }; detail: string }
  | { type: "step.finished"; step: number; output: string; ms: number; ok: boolean; sources?: Source[]; image?: GeneratedImage }
  /** What a sandbox step saved to or deleted from the room's files, and what it couldn't. */
  | ({ type: "files.synced"; step: number } & FilesSynced)
  | { type: "approval.requested"; step: number; call: ToolCall; title: string; expiresAt: string }
  | { type: "approval.settled"; step: number; decision: Exclude<ApprovalStatus, "pending">; by?: string }
  /**
   * Sandbox time is billed as `model: "sandbox"` with no tokens. `ms` is how long the model call took. `step` is set on
   * image usage, so a retried image step can see it was already billed.
   */
  | ({ type: "usage"; model: string; job: "route" | "name" | "run" | "sandbox" | "image"; costMicros: number; ms?: number; step?: number } & TokenUsage)
  /** A helper agent took a delegated task, in its own lane; `step` is the main lane's delegate step. */
  | { type: "helper.started"; step: number; agentId: string; agentName: string; task: string; model: string }
  | { type: "helper.finished"; step: number; status: RunEndStatus; summary: string; steps: number; ms: number; costMicros: number }
  | { type: "run.finished"; status: RunEndStatus; reason?: string; ms: number; steps: number; costMicros: number };

/** `lane` is absent (0) for the thread's own agent and n for the nth helper it delegated to. */
export type RunEvent = RunEventBody & { seq: number; at: string; lane?: number };
