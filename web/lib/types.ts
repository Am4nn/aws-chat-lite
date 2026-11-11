export type Role = "owner" | "admin" | "member";

export type Me = { userId: string; username: string; isCreator: boolean };

/** `mentions`: how many times I was mentioned there since I last read, across its chats. */
export type RoomSummary = { roomId: string; name: string; role: Role; mentions: number };

/** `unread` and `mentions` are mine; a muted chat still counts them, it just doesn't badge unread. */
export type Chat = { chatId: string; name: string; lastSeq: number; unread: number; mentions: number; muted: boolean };

export type Member = { userId: string; username: string; role: Role; online: boolean; lastSeen?: string };

export type RoomView = {
  room: { roomId: string; name: string; ownerId: string; archived: boolean };
  me: { role: Role };
  chats: Chat[];
  members: Member[];
  threads: ThreadSummary[];
  budget: Budget;
  defaultModel: ModelPick;
  models: ModelOption[];
};

export type Reaction = "thumbs" | "heart" | "joy" | "tada" | "eyes" | "check";

export type Attachment = { key: string; name: string; size: number; type: string; url?: string };

export type Message = {
  roomId: string;
  chatId: string;
  seq: number;
  authorId: string;
  authorName: string;
  clientId?: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  deleted?: "self" | "admin";
  replyTo?: { seq: number; authorName: string; excerpt: string };
  attachments: Attachment[];
  reactions: Partial<Record<Reaction, string[]>>;
  mentions: string[];
  everyone: boolean;
  threadRef?: { threadId: string; kind: "started" | "delivered" };
  agent?: { runId: string; status: RunEndStatus; reason?: string; steps: number; costMicros: number; ms: number; model: string; pick: ModelPick; firstSeq: number };
  /** How many times the message has changed (edit, delete, reaction); absent until the first change. */
  v?: number;
};

export type LiveEvent =
  | { type: "message.new" | "message.updated"; message: Message }
  | { type: "typing"; roomId: string; chatId: string; userId: string; username: string }
  | { type: "presence"; userId: string; online: boolean; lastSeen: string }
  | { type: "read"; roomId: string; chatId: string; lastReadSeq: number }
  | { type: "room.updated"; roomId: string }
  | { type: "run.updated"; roomId: string; thread: ThreadSummary; lastSeq: number; budget: Budget }
  | { type: "thread.updated"; roomId: string; thread: ThreadSummary }
  | { type: "budget.updated"; roomId: string; budget: Budget }
  | { type: "pong" };

export const isAdmin = (role: Role) => role === "owner" || role === "admin";

// Agent threads: mirrors services/src/threads/types.ts.
export type RunEndStatus = "done" | "stopped" | "failed" | "capped";
export type ThreadStatus = "idle" | "running" | RunEndStatus;

export type ThreadSummary = {
  roomId: string;
  threadId: string;
  number: number;
  name: string;
  status: ThreadStatus;
  rev: number;
  runId?: string;
  runFirstSeq?: number;
  startedAt?: string;
  endedAt?: string;
  steps: number;
  currentStep?: string;
  costMicros: number;
  /** The model the latest run answers on, once it has routed. */
  model?: string;
  summary?: string;
  createdBy: string;
  lastActivityAt: string;
  archived: boolean;
  taint: TaintSource[];
};

// Model choice: mirrors services/src/models/catalog.ts and privacy.ts.
export type ModelPick = "auto" | "sonnet" | "haiku" | "opus" | "fable" | "deepseek-flash" | "deepseek-pro" | "fake";
export type ModelOption = { pick: ModelPick; id?: string; label: string; short: string; price: string; privateOk: boolean };
export type TaintSource = "attachment";

export type Budget = { spentMicros: number; capMicros: number; month: string; resetsAt: string };

type RunEventBody =
  | { type: "run.started"; pick: ModelPick; startedBy: string }
  | { type: "routed"; model: string; by: "pick" | "default" | "auto" }
  | { type: "model.turn"; model: string; content: unknown; turn: number }
  | { type: "steer"; messageSeq: number; authorName: string; text: string }
  | { type: "text"; text: string; turn: number }
  | { type: "text.reset"; turn: number }
  | { type: "step.started"; step: number; call: { id: string; name: string; input: Record<string, unknown> }; detail: string }
  | { type: "step.finished"; step: number; output: string; ms: number; ok: boolean }
  | { type: "usage"; model: string; job: "route" | "name" | "run"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicros: number }
  | { type: "run.finished"; status: RunEndStatus; reason?: string; ms: number; steps: number; costMicros: number };

export type RunEvent = RunEventBody & { seq: number; at: string };
