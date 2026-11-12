"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Archive, Check, ChevronDown, LogOut, Plus } from "lucide-react";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { useEscape } from "@/lib/client/useEscape";
import { dur, easeOut, instant } from "@/lib/motion";
import type { PushState } from "@/lib/client/push";
import type { RoomSummary } from "@/lib/types";
import { NotificationsToggle } from "./NotificationsToggle";

const MENU_ITEM = "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors";

function MentionDot() {
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-lime" />;
}

export function RoomSwitcher({ current, rooms, hasMentions, canCreate, canLeave, canArchive, push, onCreate, onLeave, onArchive }: {
  current: { roomId: string; name: string }; rooms: RoomSummary[]; hasMentions: (roomId: string) => boolean;
  canCreate: boolean; canLeave: boolean; canArchive: boolean; push: { state: PushState; toggle: () => void };
  onCreate: () => void; onLeave: () => void; onArchive: () => void;
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  useEscape(open, () => {
    setOpen(false);
    button.current?.focus();
  });

  const elsewhere = rooms.some((r) => r.roomId !== current.roomId && hasMentions(r.roomId));
  const choose = (run: () => void) => () => { setOpen(false); run(); };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-[background-color,transform] hover:bg-surface-3 active:scale-[0.98]"
      >
        <span className="grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-lime font-display font-bold uppercase text-lime-ink">{current.name.slice(0, 1)}</span>
        <span className="truncate font-display text-[17px] font-bold">{current.name}</span>
        {elsewhere && <><MentionDot /><span className="sr-only">, mentions in other rooms</span></>}
        <ChevronDown aria-hidden="true" size={15} className={`ml-auto shrink-0 text-text-3 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97, transition: reduced ? instant : { duration: dur.fast } }}
            transition={reduced ? instant : { duration: dur.base, ease: easeOut }}
            style={{ transformOrigin: "top left" }}
            className="absolute inset-x-0 top-12 z-30 rounded-xl border border-line-strong bg-surface-2 p-1.5 shadow-menu"
          >
            {rooms.map((r) => (
              <Link
                key={r.roomId}
                role="menuitem"
                href={`/r/${r.roomId}`}
                onClick={() => setOpen(false)}
                className={`${MENU_ITEM} text-text-2 hover:bg-surface-3 hover:text-text`}
              >
                <span className="truncate">{r.name}</span>
                {hasMentions(r.roomId) && <><MentionDot /><span className="sr-only">, mentions</span></>}
                {r.roomId === current.roomId && <Check aria-hidden="true" size={14} className="ml-auto shrink-0 text-lime" />}
              </Link>
            ))}
            {(push.state !== "hidden" || canCreate || canLeave || canArchive) && <div role="separator" className="my-1 h-px bg-line" />}
            <NotificationsToggle state={push.state} onToggle={push.toggle} />
            {canCreate && <MenuItem onClick={choose(onCreate)} icon={<Plus aria-hidden="true" size={14} />}>New room</MenuItem>}
            {canLeave && <MenuItem danger onClick={choose(onLeave)} icon={<LogOut aria-hidden="true" size={14} />}>Leave room</MenuItem>}
            {canArchive && <MenuItem danger onClick={choose(onArchive)} icon={<Archive aria-hidden="true" size={14} />}>Archive room</MenuItem>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({ danger = false, icon, onClick, children }: { danger?: boolean; icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} className={`${MENU_ITEM} hover:bg-surface-3 ${danger ? "text-danger" : "text-text-2 hover:text-text"}`}>
      {icon}
      {children}
    </button>
  );
}
