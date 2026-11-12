"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown } from "lucide-react";
import { dur, easeOut, instant } from "@/lib/motion";

/** The pill over the bottom of a scrolled-up conversation that takes you back down to the newest message. */
export function JumpPill({ show, onClick, children }: { show: boolean; onClick: () => void; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <AnimatePresence>
        {show && (
          <motion.button
            initial={{ opacity: 0, y: reduced ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : 8 }}
            transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
            onClick={onClick}
            className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-[#1c2225] px-3.5 text-[12.5px] font-medium shadow-[0_8px_24px_rgba(0,0,0,.45)] transition-[border-color,transform] hover:border-[#36403f] active:scale-[0.97]"
          >
            {children}
            <ArrowDown aria-hidden="true" size={13} className="text-lime" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
