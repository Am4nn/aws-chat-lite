"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Pencil, Reply, X } from "lucide-react";
import { dur, easeOut, instant } from "@/lib/motion";
import type { ComposerMode } from "./Composer";

/** The strip on top of the composer saying what the next send does instead of a plain message, with a way out. */
export function ModeBanner({ mode, onCancel }: { mode: ComposerMode; onCancel: () => void }) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {mode && (
        <motion.div
          key={mode.kind}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
          className="overflow-hidden"
        >
          <div className="flex items-center gap-2 px-4 pt-2.5 text-[12.5px] text-text-2">
            {mode.kind === "reply" && <Reply aria-hidden="true" size={13} className="shrink-0 text-text-3" />}
            {mode.kind === "edit" && <Pencil aria-hidden="true" size={12} className="shrink-0 text-text-3" />}
            {mode.kind === "reply" && <span className="min-w-0 truncate">Replying to <b className="font-semibold text-text">{mode.message.authorName}</b> <span className="text-text-3">{mode.message.text}</span></span>}
            {mode.kind === "edit" && <span>Editing message</span>}
            <kbd className="ml-auto shrink-0 font-mono text-[11px] text-text-3">Esc</kbd>
            <button onClick={onCancel} aria-label="Cancel" className="grid size-6 shrink-0 place-items-center rounded-md text-text-3 transition-[background-color,color,scale] hover:bg-surface-3 hover:text-text active:scale-90">
              <X aria-hidden="true" size={13} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
