import { createContext } from "react";
import type { Chat, ThreadSummary } from "../types";

export type RoomTags = { roomId: string; threads: Pick<ThreadSummary, "number" | "name">[]; chats: Pick<Chat, "chatId" | "name">[] };

/** The room's threads and chats, so a `#tag` in any message links to what it names under its current name. */
export const RoomTagsContext = createContext<RoomTags | null>(null);

/** The server's tag: not part of a word, and not the start of a longer name. */
const TAG = /(?<!\w)#([a-z0-9-]{1,32})(?![\w-])/gi;

/**
 * A message the server would refuse: it tags one of the room's threads and says nothing else, so the thread's agent
 * would get a bare tag to make sense of.
 */
export function onlyThreadTags(text: string, tags: RoomTags): boolean {
  const named = [...text.matchAll(TAG)].some(([, tag]) =>
    tags.threads.some((t) => String(t.number) === tag || t.name.toLowerCase() === tag!.toLowerCase()));
  return named && !/[^\s,.:;-]/.test(text.replace(TAG, ""));
}

/**
 * The `#tags` in plain text that name something in the room. The server stores a thread tag as its number, which
 * survives renames, so `#12` shows the thread's name as it is today; a tag with letters can only be a chat's.
 */
export function findTags(text: string, tags: RoomTags) {
  return [...text.matchAll(TAG)].flatMap((m) => {
    const tag = m[1].toLowerCase();
    const thread = tags.threads.find((t) => String(t.number) === tag);
    const chat = tags.chats.find((c) => c.name.toLowerCase() === tag);
    const link = thread
      ? { href: `/r/${tags.roomId}/t/${thread.number}`, label: `#${thread.name}`, kind: "thread" as const }
      : chat && { href: `/r/${tags.roomId}/c/${chat.chatId}`, label: `#${chat.name}`, kind: "chat" as const };
    return link ? [{ start: m.index, end: m.index + m[0].length, ...link }] : [];
  });
}
