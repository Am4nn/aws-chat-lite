import { createContext } from "react";
import type { Chat, ThreadSummary } from "../types";
import type { MentionOption } from "./mentions";

export type RoomTags = { roomId: string; threads: Pick<ThreadSummary, "number" | "name">[]; chats: Pick<Chat, "chatId" | "name">[] };

/** The room's threads and chats, so a `#tag` in any message links to what it names under its current name. */
export const RoomTagsContext = createContext<RoomTags | null>(null);

/** The server's tag: not part of a word, and not the start of a longer name. */
const TAG = /(?<!\w)#([a-z0-9-]{1,32})(?![\w-])/gi;

/** A thread a draft's tag names: by number, or by the name the server turns into its number on the way in. */
const namesThread = (tag: string, tags: RoomTags) =>
  tags.threads.some((t) => String(t.number) === tag || t.name.toLowerCase() === tag.toLowerCase());

/**
 * A message the server would refuse: it tags one of the room's threads and says nothing else, so the thread's agent
 * would get a bare tag to make sense of.
 */
export function onlyThreadTags(text: string, tags: RoomTags): boolean {
  const named = [...text.matchAll(TAG)].some(([, tag]) => namesThread(tag!, tags));
  return named && !/[^\s,.:;-]/.test(text.replace(TAG, ""));
}

/** The `#tags` in a draft that will link once it's sent: unlike a stored message, a thread can still go by its name. */
export function findDraftTags(text: string, tags: RoomTags) {
  return [...text.matchAll(TAG)]
    .filter(([, tag]) => namesThread(tag!, tags) || tags.chats.some((c) => c.name.toLowerCase() === tag!.toLowerCase()))
    .map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

const TAG_OPTIONS = 6;

/** A whole tag, with a letter: anything else is cut short by TAG, or read as a thread number. */
const isNameTag = (name: string) => /^[a-z0-9-]{1,32}$/i.test(name) && /[a-z]/i.test(name);

/**
 * The `#` list for what was typed: the newest threads first, then the chats, each with the `tag` a pick puts in. A
 * thread whose name wouldn't read back as that name goes in by number, which shows as its name all the same; a chat
 * has no number, so one like that is left out.
 */
export function tagOptions(query: string, tags: RoomTags): MentionOption[] {
  const q = query.toLowerCase();
  const threads = tags.threads
    .filter((t) => t.name.toLowerCase().startsWith(q) || String(t.number).startsWith(q))
    .sort((a, b) => b.number - a.number)
    .map((t) => ({ name: t.name, kind: "thread" as const, number: t.number, tag: isNameTag(t.name) ? t.name : String(t.number) }));
  const chats = tags.chats
    .filter((c) => isNameTag(c.name) && c.name.toLowerCase().startsWith(q))
    .map((c) => ({ name: c.name, kind: "chat" as const, tag: c.name }));
  return [...threads, ...chats].slice(0, TAG_OPTIONS);
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
