import { isAdmin, type Message, type Role } from "../types";

/** The server's rules, mirrored so the UI only offers what will succeed. The server remains the real check. */
const EDIT_WINDOW_MS = 15 * 60_000;
const GROUP_GAP_MS = 5 * 60_000;

const withinWindow = (m: Message, now: number) => now - Date.parse(m.createdAt) <= EDIT_WINDOW_MS;

export const canEdit = (m: Message, me: string, now: number) => !m.deleted && m.authorId === me && withinWindow(m, now);

export const canDelete = (m: Message, me: string, role: Role, now: number) =>
  !m.deleted && ((m.authorId === me && withinWindow(m, now)) || isAdmin(role));

/** Up-arrow edits my newest message; when that one is too old, so is everything before it. */
export function canEditLast(messages: Message[], me: string, now: number): Message | undefined {
  const last = messages.findLast((m) => m.authorId === me && !m.deleted);
  return last && canEdit(last, me, now) ? last : undefined;
}

/** Consecutive messages from one person share a header until they pause for five minutes. */
export const startsGroup = (prev: Message | undefined, m: Message) =>
  !prev || prev.authorId !== m.authorId || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > GROUP_GAP_MS;
