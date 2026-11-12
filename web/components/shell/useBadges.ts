"use client";

import { useState } from "react";
import { countMessage, countRead } from "@/lib/client/badges";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import type { Chat, RoomSummary, RoomView } from "@/lib/types";

/**
 * The sidebar's unread and mention counts, and which rooms have mentions waiting. The room view and the room list
 * are the truth whenever they're fetched (on load, and after every `room.updated`); in between, live events keep the
 * counts moving. The open chat is read as it arrives, so it never holds a count; nor does the one a tap is opening.
 */
export function useBadges({ view, rooms, meId, openChatIds }: { view: RoomView; rooms: RoomSummary[]; meId: string; openChatIds: string[] }) {
  const roomId = view.room.roomId;
  const open = openChatIds.join(" ");
  const seen = (c: Chat): Chat => (openChatIds.includes(c.chatId) ? { ...c, unread: 0, mentions: 0 } : c);

  const [source, setSource] = useState({ chats: view.chats, rooms, open });
  const [chats, setChats] = useState(() => view.chats.map(seen));
  const [mentionedRooms, setMentionedRooms] = useState(() => new Set(rooms.filter((r) => r.mentions > 0).map((r) => r.roomId)));
  // Adjusted during render rather than in an effect, so a fresh fetch never paints one frame of stale counts.
  if (source.chats !== view.chats || source.rooms !== rooms || source.open !== open) {
    setSource({ chats: view.chats, rooms, open });
    setChats((list) => (source.chats !== view.chats ? view.chats : list).map(seen));
    if (source.rooms !== rooms) setMentionedRooms(new Set(rooms.filter((r) => r.mentions > 0).map((r) => r.roomId)));
  }

  const update = (chatId: string, change: (c: Chat) => Chat) =>
    setChats((list) => list.map((c) => (c.chatId === chatId ? seen(change(c)) : c)));

  useLiveEvent("message.new", ({ message: m }) => {
    if (m.roomId === roomId) return update(m.chatId, (c) => ({ ...c, ...countMessage(c, m, meId) }));
    if (m.authorId !== meId && (m.everyone || m.mentions.includes(meId))) setMentionedRooms((s) => new Set(s).add(m.roomId));
  });
  useLiveEvent("read", (e) => {
    if (e.roomId === roomId) update(e.chatId, (c) => ({ ...c, ...countRead(c, e.lastReadSeq) }));
  });

  const hasMentions = (id: string) => (id === roomId ? chats.some((c) => c.mentions > 0) : mentionedRooms.has(id));
  const setMuted = (chatId: string, muted: boolean) => update(chatId, (c) => ({ ...c, muted }));
  const setArchived = (chatId: string, archived: boolean) => update(chatId, (c) => ({ ...c, archived }));
  return { chats, hasMentions, setMuted, setArchived };
}
