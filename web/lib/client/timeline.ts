import type { Message } from "../types";

export type PendingMessage = {
  clientId: string;
  text: string;
  createdAt: string;
  replyTo?: Message["replyTo"];
  attachments: Message["attachments"];
  failed?: boolean;
};

export type Timeline = { messages: Message[]; pending: PendingMessage[] };

// History pages and live events overlap and can arrive out of order, so every merge dedupes by seq and re-sorts.
export function applyMessages(t: Timeline, incoming: Message[]): Timeline {
  const bySeq = new Map(t.messages.map((m) => [m.seq, m]));
  for (const m of incoming) bySeq.set(m.seq, m);
  const arrived = new Set(incoming.map((m) => m.clientId));
  return {
    messages: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    pending: t.pending.filter((p) => !arrived.has(p.clientId)),
  };
}

export const addPending = (t: Timeline, p: PendingMessage): Timeline => ({ ...t, pending: [...t.pending, p] });

export const failPending = (t: Timeline, clientId: string): Timeline => ({
  ...t,
  pending: t.pending.map((p) => (p.clientId === clientId ? { ...p, failed: true } : p)),
});

export const dropPending = (t: Timeline, clientId: string): Timeline => ({
  ...t,
  pending: t.pending.filter((p) => p.clientId !== clientId),
});

export const newestSeq = (t: Timeline) => t.messages.at(-1)?.seq ?? 0;
