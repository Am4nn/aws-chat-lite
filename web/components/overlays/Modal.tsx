"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useEscape } from "@/lib/client/useEscape";
import { dur, easeOut } from "@/lib/motion";

/** A centred dialog over a dimmed backdrop. Escape or a click outside closes it. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEscape(open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40 grid place-items-start justify-center pt-[14vh]">
          <motion.button
            aria-label="Close"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: dur.fast }}
            className="absolute inset-0 cursor-default bg-[rgba(4,6,7,.66)]"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: -10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: dur.fast } }}
            transition={{ duration: dur.base, ease: easeOut }}
            className="relative w-[440px] max-w-[calc(100vw-32px)] rounded-2xl border border-line-strong bg-surface-2 p-5 shadow-modal"
          >
            <h2 className="mb-4 font-display text-lg font-bold">{title}</h2>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
