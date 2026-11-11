"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import { useIsPhone } from "@/lib/client/useIsPhone";
import { spring } from "@/lib/motion";

type PanelTab = { id: string; label: string; content: ReactNode };

/**
 * The right-hand room panel. It slides its width rather than popping in and out, and the active tab is marked by a
 * pill that slides between tabs. The inner column keeps a fixed width so content never reflows while the panel moves.
 * On a phone it is an overlay instead, sliding in from the right edge (`overlayOpen`), and CSS decides which form
 * shows, so the first paint is right before any script runs.
 * Closed, it is inert: hidden from screen readers and out of the tab order, so focus never lands on invisible buttons.
 */
export function Panel({ open, overlayOpen, active, onActiveChange, tabs }: {
  open: boolean; overlayOpen: boolean; active: string; onActiveChange: (id: string) => void; tabs: PanelTab[];
}) {
  const phone = useIsPhone();
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <motion.aside
      aria-label="Room panel"
      inert={phone ? !overlayOpen : !open}
      initial={false}
      animate={{ width: open ? 320 : 0 }}
      transition={spring.panel}
      className={`shrink-0 overflow-hidden border-l border-line bg-surface-1 max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-[min(320px,calc(100vw-48px))]! max-md:transition-transform max-md:duration-300 max-md:ease-[cubic-bezier(.2,.9,.2,1)] ${overlayOpen ? "max-md:shadow-[0_0_60px_rgba(0,0,0,.5)]" : "max-md:translate-x-full"}`}
    >
      <div className="flex h-full w-[320px] flex-col gap-4 p-4 max-md:w-full">
        <div role="tablist" className="flex shrink-0 rounded-[11px] border border-line bg-surface-2 p-[3px]">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === current.id}
              onClick={() => onActiveChange(t.id)}
              className={`relative isolate h-8 flex-1 rounded-lg text-[12.5px] font-medium transition-[color,transform] active:scale-[0.97] ${t.id === current.id ? "text-text" : "text-text-2 hover:text-text"}`}
            >
              {t.id === current.id && <motion.span layoutId="panel-tab" transition={spring.glide} className="absolute inset-0 -z-10 rounded-lg bg-[#1c2225]" />}
              {t.label}
            </button>
          ))}
        </div>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">{current.content}</div>
      </div>
    </motion.aside>
  );
}
