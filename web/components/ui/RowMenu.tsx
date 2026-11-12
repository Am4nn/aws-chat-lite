"use client";

import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MoreHorizontal } from "lucide-react";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { useEscape } from "@/lib/client/useEscape";
import { dur, easeOut } from "@/lib/motion";

/** A row's "…" button and the menu of actions it opens. Escape closes it and gives focus back to the button. */
export function RowMenu({ open, onToggle, name, children }: { open: boolean; onToggle: (open: boolean) => void; name: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useClickOutside(ref, open, () => onToggle(false));
  useEscape(open, () => {
    onToggle(false);
    button.current?.focus();
  });

  return (
    <div ref={ref} className="relative">
      <button
        ref={button}
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="grid size-7 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-3 hover:text-text"
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: dur.fast } }}
            transition={{ duration: dur.fast, ease: easeOut }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-8 z-20 w-44 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-menu"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({ danger = false, onClick, children }: { danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-surface-3 ${danger ? "text-danger" : "text-text-2 hover:text-text"}`}
    >
      {children}
    </button>
  );
}
