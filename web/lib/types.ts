export type Role = "owner" | "admin" | "member";

export type Me = { userId: string; username: string; isCreator: boolean };

export type RoomSummary = { roomId: string; name: string; role: Role };

export type Chat = { chatId: string; name: string };

export type Member = { userId: string; username: string; role: Role };

export type RoomView = {
  room: { roomId: string; name: string; ownerId: string };
  me: { role: Role };
  chats: Chat[];
  members: Member[];
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
  agent?: { runId: string; status: RunEndStatus; reason?: string; steps: number; costMicros: number; ms: number; model: string; firstSeq: number };
};

export type LiveEvent =
  | { type: "message.new" | "message.updated"; message: Message }
  | { type: "typing"; roomId: string; chatId: string; userId: string; username: string }
  | { type: "presence"; userId: string; online: boolean; lastSeen: string }
  | { type: "read"; roomId: string; chatId: string; lastReadSeq: number }
  | { type: "room.updated"; roomId: string }
  | { type: "run.updated"; roomId: string; thread: ThreadSummary; lastSeq: number; budget: Budget }
  | { type: "thread.updated"; roomId: string; thread: ThreadSummary }
  | { type: "pong" };

export const isAdmin =(role: Role) => role === "owner" || role === "admin";

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
  summary?: string;
  createdBy: string;
  lastActivityAt: string;
  archived: boolean;
};

export type Budget = { spentMicros: number; capMicros: number; month: string; resetsAt: string };

type RunEventBody =
  | { type: "run.started"; model: string; startedBy: string }
  | { type: "steer"; messageSeq: number; authorName: string; text: string }
  | { type: "text"; text: string }
  | { type: "step.started"; step: number; call: { id: string; name: string; input: Record<string, unknown> }; detail: string }
  | { type: "step.finished"; step: number; output: string; ms: number; ok: boolean }
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number; costMicros: number }
  | { type: "run.finished"; status: RunEndStatus; reason?: string; ms: number; steps: number; costMicros: number };

export type RunEvent = RunEventBody & { seq: number; at: string };
