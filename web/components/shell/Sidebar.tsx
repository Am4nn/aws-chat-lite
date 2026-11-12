"use client";

import { useId, useRef, useState, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AppWindow, Archive, ArchiveRestore, Bell, BellOff, ChevronRight, Hash, LogOut, MoreHorizontal, Pencil, Plus, PanelLeftClose, Search, type LucideIcon,
} from "lucide-react";
import { chatBadge } from "@/lib/client/badges";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { useEscape } from "@/lib/client/useEscape";
import { dur, easeOut, instant, spring } from "@/lib/motion";
import type { Chat, Me } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";
import { Hint } from "@/components/ui/Hint";

type MenuAction = { label: string; icon: LucideIcon; run: () => void };

/**
 * `chats` come oldest first. `canManage`: I may create, rename and archive chats here (an admin, in a room that isn't
 * archived); only then do archived chats show, in their own closed list, since everyone else reaches them by link or
 * search.
 */
export function Sidebar({
  chats, me, roomId, canManage, switcher, threads, budget, activeChatId, newChatIds, onPalette, onNewChat, onRename, onArchive, onMute, onSignOut, onCollapse,
}: {
  chats: Chat[]; me: Me; roomId: string; canManage: boolean; switcher: ReactNode; threads: ReactNode; budget: ReactNode;
  activeChatId?: string; newChatIds: Set<string>;
  onPalette: () => void; onNewChat: () => void; onRename: (chat: Chat) => void; onArchive: (chat: Chat, archived: boolean) => void;
  onMute: (chat: Chat, muted: boolean) => void; onSignOut: () => void; onCollapse: () => void;
}) {
  const headingId = useId();
  const open = chats.filter((c) => !c.archived);
  const archived = chats.filter((c) => c.archived);
  // The room opens on its first chat, so that one is never archived.
  const firstChatId = chats[0]?.chatId;

  function actionsFor(chat: Chat): MenuAction[] {
    const mute = { label: chat.muted ? "Unmute chat" : "Mute chat", icon: chat.muted ? Bell : BellOff, run: () => onMute(chat, !chat.muted) };
    if (!canManage) return chat.archived ? [] : [mute];
    const rename = { label: "Rename", icon: Pencil, run: () => onRename(chat) };
    if (chat.archived) return [rename, { label: "Unarchive", icon: ArchiveRestore, run: () => onArchive(chat, false) }];
    return [mute, rename, ...(chat.chatId === firstChatId ? [] : [{ label: "Archive", icon: Archive, run: () => onArchive(chat, true) }])];
  }

  const row = (chat: Chat) => (
    <ChatRow
      key={chat.chatId} chat={chat} roomId={roomId} active={chat.chatId === activeChatId} fresh={newChatIds.has(chat.chatId)}
      actions={actionsFor(chat)}
    />
  );

  return (
    <nav aria-label="Room" className="flex w-[272px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-surface-1 px-3 py-4">
      <div className="flex shrink-0 items-center gap-1">
        <div className="min-w-0 flex-1">{switcher}</div>
        <button
          onClick={onCollapse}
          aria-label="Hide sidebar"
          title="Hide sidebar"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-text-3 transition-[background-color,color,transform] hover:bg-surface-2 hover:text-text active:scale-90 max-md:hidden"
        >
          <PanelLeftClose aria-hidden="true" size={15} />
        </button>
      </div>

      <button
        onClick={onPalette}
        className="flex h-[38px] shrink-0 items-center gap-2 rounded-[10px] border border-line-strong bg-surface-2 px-3 text-[13px] text-text-3 transition-[border-color,background-color,color] hover:border-line-hover hover:text-text-2 active:bg-surface-3"
      >
        <Search aria-hidden="true" size={15} />
        <span className="whitespace-nowrap">Ask, jump, run</span>
        <kbd className="ml-auto whitespace-nowrap rounded-[5px] border border-line-strong px-1.5 font-mono text-[11px]">Ctrl K</kbd>
      </button>

      {threads}

      <section>
        <div className="flex h-[30px] items-center pb-1.5 pl-2.5">
          <h2 id={headingId} className="text-[11.5px] font-semibold text-text-3">Chats</h2>
          {canManage && (
            <button onClick={onNewChat} aria-label="New chat" className="ml-auto grid size-6 place-items-center rounded-md text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90">
              <Plus aria-hidden="true" size={14} />
            </button>
          )}
        </div>
        <ul aria-labelledby={headingId} className="flex flex-col gap-1">{open.map(row)}</ul>
      </section>

      {canManage && archived.length > 0 && (
        <ArchivedChats key={roomId} holdsActive={archived.some((c) => c.chatId === activeChatId)} count={archived.length}>
          {archived.map(row)}
        </ArchivedChats>
      )}

      <div className="mt-auto flex flex-col gap-3">
        {budget}
        <div className="flex items-center gap-2.5 px-1.5">
          <Avatar name={me.username} />
          <span className="truncate text-[13px]">{me.username}</span>
          <Link href="/apps" aria-label="Connected apps" className="ml-auto grid size-8 shrink-0 place-items-center rounded-lg text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90">
            <AppWindow aria-hidden="true" size={15} />
          </Link>
          <button onClick={onSignOut} aria-label="Sign out" className="grid shrink-0 size-8 place-items-center rounded-lg text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90">
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
function ChatRow({ chat, roomId, active, fresh, actions }: { chat: Chat; roomId: string; active: boolean; fresh: boolean; actions: MenuAction[] }) {
  const { count, mention } = chatBadge(chat);
  const spoken = [count && `${count} unread`, mention && `${mention} ${mention === 1 ? "mention" : "mentions"}`].filter(Boolean).join(", ");

  return (
    <li className={`group relative ${fresh ? "animate-[row-in_.45s_cubic-bezier(.2,.9,.2,1)_both] motion-reduce:animate-none" : ""}`}>
      <Link
        href={`/r/${roomId}/c/${chat.chatId}`}
        aria-current={active ? "page" : undefined}
        className={`relative isolate flex h-10 items-center gap-2.5 rounded-[10px] pl-2.5 pr-10 text-[13.5px] transition-colors active:bg-surface-3 ${
          active ? "text-text" : count || mention ? "font-medium text-text group-hover:bg-surface-2" : chat.archived ? "text-text-3 group-hover:bg-surface-2 group-hover:text-text-2" : "text-text-2 group-hover:bg-surface-2 group-hover:text-text"
        }`}
      >
        {active && (
          <motion.span layoutId="nav-highlight" transition={spring.glide} className="absolute inset-0 -z-10 rounded-[10px] bg-surface-3 shadow-ring" />
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
      {actions.length > 0 && <RowMenu name={chat.name} actions={actions} />}
    </li>
  );
}

/** Starts closed, unless the chat I have open is one of them. */
function ArchivedChats({ holdsActive, count, children }: { holdsActive: boolean; count: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(holdsActive);
  const listId = useId();
  return (
    <section>
      <div className="flex h-[30px] items-center pb-1.5">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex h-6 items-center gap-1 rounded-md pl-1.5 pr-2 text-[11.5px] font-semibold text-text-3 transition-[background-color,color] hover:bg-surface-2 hover:text-text-2 active:bg-surface-3"
        >
          <ChevronRight aria-hidden="true" size={13} className={`transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
          Archived chats · {count}
        </button>
        <Hint text="Read-only and out of everyone's list; members still reach them by link or search. Unarchive one from its menu." />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            id={listId}
            aria-label="Archived chats"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
            className="flex flex-col gap-1 overflow-hidden"
          >
            {children}
          </motion.ul>
        )}
      </AnimatePresence>
    </section>
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

function RowMenu({ name, actions }: { name: string; actions: MenuAction[] }) {
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
            className="absolute right-0 top-8 z-30 w-40 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-menu"
          >
            {actions.map(({ label, icon: Icon, run }, i) => (
              <button
                key={label}
                role="menuitem"
                autoFocus={i === 0}
                onClick={() => { setOpen(false); run(); }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-text-2 transition-colors hover:bg-surface-3 hover:text-text focus-visible:bg-surface-3 focus-visible:outline-none active:bg-surface-3"
              >
                <Icon aria-hidden="true" size={14} />
                {label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
