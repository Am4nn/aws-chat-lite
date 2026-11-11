import type { Chat, Message } from "../types";

type ChatCounts = Pick<Chat, "lastSeq" | "unread" | "mentions" | "muted">;

/** A muted chat hides its unread count; a mention always shows. */
export function chatBadge({ unread, mentions, muted }: Pick<Chat, "unread" | "mentions" | "muted">) {
  return { count: unread > 0 && !muted ? unread : null, mention: mentions > 0 ? mentions : null };
}

/**
 * A live message in a chat I'm not looking at. Unread is everything past my read marker (lastSeq − unread), the way the
 * server counts it, so a repeat delivery changes nothing and one arriving out of order still counts. Mentions are
 * counted only for a seq past the newest seen, so a repeat can't count twice; the price is that a mention arriving
 * out of order is missed until the room view is fetched again (on any `room.updated`, a reload or a room switch).
 */
export function countMessage(c: ChatCounts, m: Pick<Message, "seq" | "authorId" | "mentions" | "everyone">, meId: string): ChatCounts {
  const mine = m.authorId === meId;
  const readTo = mine ? Math.max(c.lastSeq - c.unread, m.seq) : c.lastSeq - c.unread;
  const lastSeq = Math.max(c.lastSeq, m.seq);
  const mentionsMe = !mine && m.seq > c.lastSeq && (m.everyone || m.mentions.includes(meId));
  return { ...c, lastSeq, unread: Math.max(0, lastSeq - readTo), mentions: c.mentions + (mentionsMe ? 1 : 0) };
}

/** I read the chat in another tab: the server cleared its mentions and moved the marker. */
export const countRead = (c: ChatCounts, lastReadSeq: number): ChatCounts =>
  ({ ...c, unread: Math.max(0, c.lastSeq - lastReadSeq), mentions: 0 });
