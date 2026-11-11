import type { Message } from "../types";

export type PendingMessage = {
  clientId: string;
  text: string;
  createdAt: string;
  replyTo?: Message["replyTo"];
  /** Sent from a chat into this agent thread. */
  threadId?: string;
  attachments: Message["attachments"];
  failed?: boolean;
};

/** Rows keep one identity from pending to stored, so a sent message doesn't re-enter when its ack lands. */
export const keyOf = (m: { clientId?: string; seq?: number }) => (m.clientId ? `c:${m.clientId}` : `s:${m.seq}`);

export type Timeline = { messages: Message[]; pending: PendingMessage[] };

/**
 * History pages and live events overlap and can arrive out of order, so every merge dedupes by seq and re-sorts, and
 * of two copies of one message keeps the later version: a page read before an edit, delete or reaction never undoes it.
 */
export function applyMessages(t: Timeline, incoming: Message[]): Timeline {
  const bySeq = new Map(t.messages.map((m) => [m.seq, m]));
  for (const m of incoming) {
    const current = bySeq.get(m.seq);
    if (!current || (m.v ?? 0) >= (current.v ?? 0)) bySeq.set(m.seq, m);
  }
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

/** A live message past the next seq means events were missed while the socket stayed open. */
export const skipsAhead = (t: Timeline, seq: number) => seq > newestSeq(t) + 1;

/** Changes the loaded copy of message `seq`, whatever has happened to it since; unloaded messages are left alone. */
export function updateMessage(t: Timeline, seq: number, change: (m: Message) => Message): Timeline {
  const index = t.messages.findIndex((m) => m.seq === seq);
  if (index < 0) return t;
  return { ...t, messages: t.messages.with(index, change(t.messages[index])) };
}
