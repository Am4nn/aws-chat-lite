"use client";

import { useRef, useState, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bell, BellOff, Hash, LogOut, MoreHorizontal, Plus, Search } from "lucide-react";
import { chatBadge } from "@/lib/client/badges";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { useEscape } from "@/lib/client/useEscape";
import { dur, easeOut, instant, spring } from "@/lib/motion";
import type { Chat, Me } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";

export function Sidebar({ chats, me, roomId, canAddChat, switcher, threads, budget, activeChatId, newChatIds, onPalette, onNewChat, onMute, onSignOut }: {
  chats: Chat[]; me: Me; roomId: string; canAddChat: boolean; switcher: ReactNode; threads: ReactNode; budget: ReactNode;
  activeChatId?: string; newChatIds: Set<string>;
  onPalette: () => void; onNewChat: () => void; onMute: (chat: Chat, muted: boolean) => void; onSignOut: () => void;
}) {
  return (
    <nav aria-label="Room" className="flex w-[272px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-surface-1 px-3 py-4">
      {switcher}

      <button
        onClick={onPalette}
        className="flex h-[38px] shrink-0 items-center gap-2 rounded-[10px] border border-line-strong bg-surface-2 px-3 text-[13px] text-text-3 transition-[border-color,color,transform] hover:border-[#36403f] hover:text-text-2 active:scale-[0.98]"
      >
        <Search aria-hidden="true" size={15} />
        <span className="whitespace-nowrap">Ask, jump, run</span>
        <kbd className="ml-auto whitespace-nowrap rounded-[5px] border border-line-strong px-1.5 font-mono text-[11px]">Ctrl K</kbd>
      </button>

      {threads}

      <section>
        <div className="flex h-[30px] items-center pb-1.5 pl-2.5">
          <h2 className="text-[11.5px] font-semibold text-text-3">Chats</h2>
          {canAddChat && (
            <button onClick={onNewChat} aria-label="New chat" className="ml-auto grid size-6 place-items-center rounded-md text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90">
              <Plus aria-hidden="true" size={14} />
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {chats.map((chat) => (
            <ChatRow
              key={chat.chatId} chat={chat} roomId={roomId} active={chat.chatId === activeChatId} fresh={newChatIds.has(chat.chatId)}
              onMute={(muted) => onMute(chat, muted)}
            />
          ))}
        </ul>
      </section>

      <div className="mt-auto flex flex-col gap-3">
        {budget}
        <div className="flex items-center gap-2.5 px-1.5">
          <Avatar name={me.username} />
          <span className="truncate text-[13px]">{me.username}</span>
          <button onClick={onSignOut} aria-label="Sign out" className="ml-auto grid size-8 place-items-center rounded-lg text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90">
            <LogOut aria-hidden="true" size={15} />
          </button>
        </div>
      </div>
    </nav>
  );
}

/**
 * The active row's highlight is one shared element that glides between rows, the thread list's included, instead of jumping. The row's menu
 * button keeps its slot when hidden, so badges never move when the pointer arrives.
 */
function ChatRow({ chat, roomId, active, fresh, onMute }: { chat: Chat; roomId: string; active: boolean; fresh: boolean; onMute: (muted: boolean) => void }) {
  const { count, mention } = chatBadge(chat);
  const spoken = [count && `${count} unread`, mention && `${mention} ${mention === 1 ? "mention" : "mentions"}`].filter(Boolean).join(", ");

  return (
    <li className={`group relative ${fresh ? "animate-[row-in_.45s_cubic-bezier(.2,.9,.2,1)_both] motion-reduce:animate-none" : ""}`}>
      <Link
        href={`/r/${roomId}/c/${chat.chatId}`}
        aria-current={active ? "page" : undefined}
        className={`relative isolate flex h-10 items-center gap-2.5 rounded-[10px] pl-2.5 pr-10 text-[13.5px] transition-colors ${
          active ? "text-text" : count || mention ? "font-medium text-text group-hover:bg-surface-2" : "text-text-2 group-hover:bg-surface-2 group-hover:text-text"
        }`}
      >
        {active && (
          <motion.span layoutId="nav-highlight" transition={spring.glide} className="absolute inset-0 -z-10 rounded-[10px] bg-surface-3 shadow-[inset_0_0_0_1px_#20272a]" />
        )}
        <Hash aria-hidden="true" size={14} className="shrink-0 text-text-3" />
        <span className="truncate">{chat.name}</span>
        {chat.muted && <BellOff role="img" aria-label="muted" size={12} className="shrink-0 text-text-3" />}
        <span aria-hidden="true" className="ml-auto flex shrink-0 items-center gap-1">
          <AnimatePresence mode="popLayout" initial={false}>
            {mention && <CountBadge key={`m${mention}`} mention>@{mention}</CountBadge>}
            {count && <CountBadge key={`c${count}`}>{count}</CountBadge>}
          </AnimatePresence>
        </span>
        {spoken && <span className="sr-only">, {spoken}</span>}
      </Link>
      <RowMenu name={chat.name} muted={chat.muted} onMute={onMute} />
    </li>
  );
}

/**
 * Keyed by its value, so every change mounts a fresh badge that pops in while the old one fades out of the flow
 * (AnimatePresence's popLayout, which needs the ref).
 */
function CountBadge({ mention = false, ref, children }: { mention?: boolean; ref?: Ref<HTMLSpanElement>; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      ref={ref}
      initial={{ opacity: 0, scale: reduced ? 1 : 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: reduced ? instant : { duration: dur.fast } }}
      transition={reduced ? instant : spring.pop}
      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-bold ${mention ? "bg-lime text-lime-ink" : "bg-text text-ink"}`}
    >
      {children}
    </motion.span>
  );
}

function RowMenu({ name, muted, onMute }: { name: string; muted: boolean; onMute: (muted: boolean) => void }) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  useEscape(open, () => {
    setOpen(false);
    button.current?.focus();
  });

  return (
    <div ref={ref} className="absolute right-1.5 top-1.5">
      <button
        ref={button}
        aria-label={`Options for #${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid size-7 place-items-center rounded-md text-text-3 opacity-0 transition-[opacity,background-color,color,transform] hover:bg-surface-3 hover:text-text focus-visible:opacity-100 active:scale-90 aria-expanded:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, transition: reduced ? instant : { duration: dur.fast } }}
            transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-8 z-30 w-40 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-[0_16px_40px_rgba(0,0,0,.5)]"
          >
            <button
              role="menuitem"
              autoFocus
              onClick={() => { setOpen(false); onMute(!muted); }}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-text-2 transition-colors hover:bg-surface-3 hover:text-text focus-visible:bg-surface-3 focus-visible:outline-none"
            >
              {muted ? <Bell aria-hidden="true" size={14} /> : <BellOff aria-hidden="true" size={14} />}
              {muted ? "Unmute chat" : "Mute chat"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
