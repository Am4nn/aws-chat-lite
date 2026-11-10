"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Bot, Hash, LogOut, Plus, Search } from "lucide-react";
import { spring } from "@/lib/motion";
import type { Chat, Me, RoomSummary, RoomView } from "@/lib/types";
import { isAdmin } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";
import { RoomSwitcher } from "./RoomSwitcher";

const ROOM_BUDGET = 3;

export function Sidebar({ view, rooms, me, activeChatId, newChatIds, onPalette, onNewChat, onNewRoom, onSignOut }: {
  view: RoomView; rooms: RoomSummary[]; me: Me; activeChatId?: string; newChatIds: Set<string>;
  onPalette: () => void; onNewChat: () => void; onNewRoom: () => void; onSignOut: () => void;
}) {
  const { room } = view;
  const spent = 0;

  return (
    <nav aria-label="Room" className="flex w-[272px] shrink-0 flex-col gap-5 border-r border-line bg-surface-1 px-3 py-4">
      <RoomSwitcher current={room} rooms={rooms} canCreate={me.isCreator} onCreate={onNewRoom} />

      <button
        onClick={onPalette}
        className="flex h-[38px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface-2 px-3 text-[13px] text-text-3 transition-colors hover:border-[#36403f] hover:text-text-2"
      >
        <Search aria-hidden="true" size={15} />
        <span className="whitespace-nowrap">Ask, jump, run</span>
        <kbd className="ml-auto whitespace-nowrap rounded-[5px] border border-line-strong px-1.5 font-mono text-[11px]">Ctrl K</kbd>
      </button>

      <section>
        <h2 className="px-2.5 pb-1.5 text-[11.5px] font-semibold text-text-3">Agent threads</h2>
        <div className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[12.5px] leading-snug text-text-3">
          <Bot aria-hidden="true" size={15} className="shrink-0" />
          Agent work will appear here as threads.
        </div>
      </section>

      <section>
        <div className="flex items-center px-2.5 pb-1.5">
          <h2 className="text-[11.5px] font-semibold text-text-3">Chats</h2>
          {isAdmin(view.me.role) && (
            <button onClick={onNewChat} aria-label="New chat" className="ml-auto grid size-6 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-3 hover:text-text">
              <Plus aria-hidden="true" size={14} />
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {view.chats.map((chat) => (
            <ChatRow key={chat.chatId} chat={chat} roomId={room.roomId} active={chat.chatId === activeChatId} fresh={newChatIds.has(chat.chatId)} />
          ))}
        </ul>
      </section>

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
          <div className="flex items-baseline text-xs text-text-2">
            Room budget
            <span className="ml-auto font-mono text-text">${spent.toFixed(2)}</span>
            <span className="font-mono text-text-3">&nbsp;/ ${ROOM_BUDGET}</span>
          </div>
          <span className="block h-1 overflow-hidden rounded-full bg-[#1c2225]">
            <span className="block h-1 bg-lime transition-[width] duration-500" style={{ width: `${(spent / ROOM_BUDGET) * 100}%` }} />
          </span>
        </div>
        <div className="flex items-center gap-2.5 px-1.5">
          <Avatar name={me.username} />
          <span className="truncate text-[13px]">{me.username}</span>
          <button onClick={onSignOut} aria-label="Sign out" className="ml-auto grid size-8 place-items-center rounded-lg text-text-3 transition-colors hover:bg-surface-3 hover:text-text">
            <LogOut aria-hidden="true" size={15} />
          </button>
        </div>
      </div>
    </nav>
  );
}

/** The active row's highlight is one shared element that glides between rows instead of jumping. */
function ChatRow({ chat, roomId, active, fresh }: { chat: Chat; roomId: string; active: boolean; fresh: boolean }) {
  return (
    <li className={fresh ? "animate-[row-in_.45s_cubic-bezier(.2,.9,.2,1)_both] motion-reduce:animate-none" : undefined}>
      <Link
        href={`/r/${roomId}/c/${chat.chatId}`}
        aria-current={active ? "page" : undefined}
        className={`relative isolate flex h-10 items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] transition-colors ${active ? "text-text" : "text-text-2 hover:text-text"}`}
      >
        {active && (
          <motion.span layoutId="chat-highlight" transition={spring.glide} className="absolute inset-0 -z-10 rounded-[10px] bg-surface-3 shadow-[inset_0_0_0_1px_#20272a]" />
        )}
        <Hash aria-hidden="true" size={14} className="text-text-3" />
        {chat.name}
      </Link>
    </li>
  );
}
