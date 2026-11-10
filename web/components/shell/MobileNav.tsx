"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useIsPhone } from "@/lib/client/useIsPhone";
import { dur, instant } from "@/lib/motion";

/**
 * Below the `md` breakpoint the sidebar is a drawer that slides in from the left; from `md` up it sits in the layout
 * as usual. CSS picks the form, so a phone never paints the sidebar squeezed beside the chat, even before hydration.
 */
export function MobileNav({ open, children }: { open: boolean; children: ReactNode }) {
  const phone = useIsPhone();
  return (
    <div
      inert={phone && !open}
      className={`flex shrink-0 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform max-md:duration-300 max-md:ease-[cubic-bezier(.2,.9,.2,1)] ${open ? "max-md:shadow-[0_0_60px_rgba(0,0,0,.5)]" : "max-md:-translate-x-full"}`}
    >
      {children}
    </div>
  );
}

/** Dims the chat behind an open drawer or panel on a phone; a tap closes it. */
export function Backdrop({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.button
          aria-label="Close"
          tabIndex={-1}
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? instant : { duration: dur.base }}
          className="fixed inset-0 z-30 cursor-default bg-[rgba(4,6,7,.66)] md:hidden"
        />
      )}
    </AnimatePresence>
  );
}
