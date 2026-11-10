import type { Chat, Message } from "../types";

type ChatCounts = Pick<Chat, "lastSeq" | "unread" | "mentions" | "muted">;

/** A muted chat hides its unread count; a mention always shows. */
export function chatBadge({ unread, mentions, muted }: Pick<Chat, "unread" | "mentions" | "muted">) {
  return { count: unread > 0 && !muted ? unread : null, mention: mentions > 0 ? mentions : null };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function lastSeenText(iso: string, now: number): string {
  const ago = now - Date.parse(iso);
  if (ago < MINUTE) return "last seen just now";
  if (ago < HOUR) return `last seen ${Math.floor(ago / MINUTE)}m ago`;
  if (ago < DAY) return `last seen ${Math.floor(ago / HOUR)}h ago`;
  return `last seen ${Math.floor(ago / DAY)}d ago`;
}

/**
 * A live message in a chat I'm not looking at. Only a seq past the last one counted moves anything, so a repeated
 * delivery counts once; the room view, fetched again on any change, corrects whatever a missed event left out.
 */
export function countMessage(c: ChatCounts, m: Pick<Message, "seq" | "authorId" | "mentions" | "everyone">, meId: string): ChatCounts {
  if (m.seq <= c.lastSeq) return c;
  if (m.authorId === meId) return { ...c, lastSeq: m.seq };
  const mentionsMe = m.everyone || m.mentions.includes(meId);
  return { ...c, lastSeq: m.seq, unread: c.unread + 1, mentions: c.mentions + (mentionsMe ? 1 : 0) };
}

/** I read the chat in another tab: the server cleared its mentions and moved the marker. */
export const countRead = (c: ChatCounts, lastReadSeq: number): ChatCounts =>
  ({ ...c, unread: Math.max(0, c.lastSeq - lastReadSeq), mentions: 0 });
