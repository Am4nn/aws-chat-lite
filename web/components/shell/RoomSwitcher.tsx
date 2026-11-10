"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { dur, easeOut } from "@/lib/motion";
import type { RoomSummary } from "@/lib/types";

export function RoomSwitcher({ current, rooms, canCreate, onCreate }: {
  current: { roomId: string; name: string }; rooms: RoomSummary[]; canCreate: boolean; onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors hover:bg-surface-3"
      >
        <span className="grid size-[30px] place-items-center rounded-[9px] bg-lime font-display font-bold uppercase text-lime-ink">{current.name.slice(0, 1)}</span>
        <span className="truncate font-display text-[17px] font-bold">{current.name}</span>
        <ChevronDown aria-hidden="true" size={15} className={`ml-auto text-text-3 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: dur.fast } }}
            transition={{ duration: dur.base, ease: easeOut }}
            style={{ transformOrigin: "top left" }}
            className="absolute inset-x-0 top-12 z-30 rounded-xl border border-line-strong bg-surface-2 p-1.5 shadow-[0_20px_50px_rgba(0,0,0,.5)]"
          >
            {rooms.map((r) => (
              <Link
                key={r.roomId}
                role="menuitem"
                href={`/r/${r.roomId}`}
                onClick={() => setOpen(false)}
                className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-text-2 hover:bg-surface-3 hover:text-text"
              >
                <span className="truncate">{r.name}</span>
                {r.roomId === current.roomId && <Check aria-hidden="true" size={14} className="ml-auto text-lime" />}
              </Link>
            ))}
            {canCreate && (
              <button
                role="menuitem"
                onClick={() => { setOpen(false); onCreate(); }}
                className="mt-1 flex h-9 w-full items-center gap-2.5 rounded-lg border-t border-line px-2.5 text-[13.5px] text-text-2 hover:bg-surface-3 hover:text-text"
              >
                <Plus aria-hidden="true" size={14} /> New room
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
