"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useIsPhone } from "@/lib/client/useIsPhone";
import { dur, instant } from "@/lib/motion";

/**
 * Below the `md` breakpoint the sidebar is a drawer that slides in from the left; from `md` up it sits in the layout,
 * unless the reader hid it (`collapsed`), when it takes no room at all. CSS picks the form, so a phone never paints the sidebar squeezed beside the chat, even before hydration.
 * Opening the drawer moves focus into it, and closing it with Escape or the backdrop hands focus back to whatever
 * opened it (the menu button), as a dialog does: the chat behind is inert meanwhile, so focus left there would be lost.
 * A drawer closed by following one of its links leaves focus to the page it led to.
 */
export function MobileNav({ open, collapsed, children }: { open: boolean; collapsed: boolean; children: ReactNode }) {
  const phone = useIsPhone();
  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !phone) return;
    const opener = document.activeElement as HTMLElement | null;
    const openedOn = window.location.pathname;
    drawer.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    return () => {
      if (window.location.pathname === openedOn) opener?.focus();
    };
  }, [open, phone]);
  return (
    <div
      ref={drawer}
      inert={phone ? !open : collapsed}
      className={`flex shrink-0 md:overflow-hidden md:transition-[width] md:duration-300 motion-reduce:transition-none ${collapsed ? "md:w-0" : "md:w-[272px]"} max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform max-md:duration-300 max-md:ease-[cubic-bezier(.2,.9,.2,1)] ${open ? "max-md:shadow-drawer" : "max-md:-translate-x-full"}`}
    >
      {children}
    </div>
  );
}

/** Dims the chat behind an open drawer or panel; a tap closes it. */
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
          className="fixed inset-0 z-30 cursor-default bg-[rgba(4,6,7,.66)] min-[1152px]:hidden"
        />
      )}
    </AnimatePresence>
  );
}
