"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { useIsNarrow } from "@/lib/client/useIsPhone";
import { spring } from "@/lib/motion";

type PanelTab = { id: string; label: string; icon: LucideIcon; content: ReactNode };

/**
 * The right-hand room panel. It slides its width rather than popping in and out, and the active tab is marked by a
 * pill that slides between tabs. The inner column keeps a fixed width so content never reflows while the panel moves.
 * The tabs don't fit in 320 px as labels, so every tab is an icon (named on hover and to screen readers) and the active
 * tab's name heads the panel instead. The tab bar is one Tab stop; arrow keys, Home and End move along it.
 * On a phone it is an overlay instead, sliding in from the right edge (`overlayOpen`), and CSS decides which form
 * shows, so the first paint is right before any script runs.
 * Closed, it is inert: hidden from screen readers and out of the tab order, so focus never lands on invisible buttons.
 */
export function Panel({ open, overlayOpen, active, onActiveChange, tabs }: {
  open: boolean; overlayOpen: boolean; active: string; onActiveChange: (id: string) => void; tabs: PanelTab[];
}) {
  const narrow = useIsNarrow();
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const headingId = useId();
  const panelId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent) {
    const at = tabs.indexOf(current);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const i = (next + tabs.length) % tabs.length;
    onActiveChange(tabs[i].id);
    buttons.current[i]?.focus();
  }

  return (
    <motion.aside
      aria-label="Room panel"
      inert={narrow ? !overlayOpen : !open}
      initial={false}
      animate={{ width: open ? 320 : 0 }}
      transition={spring.panel}
      className={`shrink-0 overflow-hidden border-l border-line bg-surface-1 max-[1152px]:fixed max-[1152px]:inset-y-0 max-[1152px]:right-0 max-[1152px]:z-40 max-[1152px]:w-[min(320px,calc(100vw-48px))]! max-[1152px]:transition-transform max-[1152px]:duration-300 max-[1152px]:ease-[cubic-bezier(.2,.9,.2,1)] ${overlayOpen ? "max-[1152px]:shadow-drawer" : "max-[1152px]:translate-x-full"}`}
    >
      <div className="flex h-full w-[320px] flex-col gap-4 p-4 max-[1152px]:w-full">
        <div role="tablist" aria-label="Room panel tabs" onKeyDown={onKeyDown} className="flex shrink-0 rounded-[11px] border border-line bg-surface-2 p-[3px]">
          {tabs.map((t, i) => {
            const selected = t.id === current.id;
            return (
              <motion.button
                key={t.id}
                ref={(el) => { buttons.current[i] = el; }}
                whileTap={{ scale: 0.92 }}
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                aria-label={t.label}
                title={t.label}
                onClick={() => onActiveChange(t.id)}
                className={`relative isolate grid h-8 min-w-0 flex-1 place-items-center rounded-lg transition-colors ${selected ? "text-text" : "text-text-3 hover:text-text"}`}
              >
                {selected && <motion.span layoutId="panel-tab" transition={spring.glide} className="absolute inset-0 -z-10 rounded-lg bg-surface-4" />}
                <t.icon aria-hidden="true" size={15} />
              </motion.button>
            );
          })}
        </div>
        <h2 id={headingId} className="-mb-1 shrink-0 truncate font-display text-[15px] font-bold">{current.label}</h2>
        <div id={panelId} role="tabpanel" aria-labelledby={headingId} className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">{current.content}</div>
      </div>
    </motion.aside>
  );
}
