"use client";

import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { useIsPhone } from "@/lib/client/useIsPhone";
import { spring } from "@/lib/motion";

type PanelTab = { id: string; label: string; icon: LucideIcon; content: ReactNode };

/**
 * The right-hand room panel. It slides its width rather than popping in and out, and the active tab is marked by a
 * pill that slides between tabs. The inner column keeps a fixed width so content never reflows while the panel moves.
 * Nine labelled tabs don't fit in 320 px, so every tab is an icon (named on hover and to screen readers) and the active
 * tab's name heads the panel instead.
 * On a phone it is an overlay instead, sliding in from the right edge (`overlayOpen`), and CSS decides which form
 * shows, so the first paint is right before any script runs.
 * Closed, it is inert: hidden from screen readers and out of the tab order, so focus never lands on invisible buttons.
 */
export function Panel({ open, overlayOpen, active, onActiveChange, tabs }: {
  open: boolean; overlayOpen: boolean; active: string; onActiveChange: (id: string) => void; tabs: PanelTab[];
}) {
  const phone = useIsPhone();
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const headingId = useId();

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
        <div role="tablist" aria-label="Room panel tabs" className="flex shrink-0 rounded-[11px] border border-line bg-surface-2 p-[3px]">
          {tabs.map((t) => {
            const selected = t.id === current.id;
            return (
              <motion.button
                key={t.id}
                whileTap={{ scale: 0.92 }}
                role="tab"
                aria-selected={selected}
                aria-label={t.label}
                title={t.label}
                onClick={() => onActiveChange(t.id)}
                className={`relative isolate grid h-8 min-w-0 flex-1 place-items-center rounded-lg transition-colors ${selected ? "text-text" : "text-text-3 hover:text-text"}`}
              >
                {selected && <motion.span layoutId="panel-tab" transition={spring.glide} className="absolute inset-0 -z-10 rounded-lg bg-[#1c2225]" />}
                <t.icon aria-hidden="true" size={15} />
              </motion.button>
            );
          })}
        </div>
        <h2 id={headingId} className="-mb-1 shrink-0 truncate font-display text-[15px] font-bold">{current.label}</h2>
        <div role="tabpanel" aria-labelledby={headingId} className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">{current.content}</div>
      </div>
    </motion.aside>
  );
}
