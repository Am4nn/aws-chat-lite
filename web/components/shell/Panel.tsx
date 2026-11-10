"use client";

import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { spring } from "@/lib/motion";

export type PanelTab = { id: string; label: string; content: ReactNode };

/**
 * The right-hand room panel. It slides its width rather than popping in and out, and the active tab is marked by a
 * pill that slides between tabs. The inner column keeps a fixed width so content never reflows while the panel moves.
 */
export function Panel({ open, tabs }: { open: boolean; tabs: PanelTab[] }) {
  const [active, setActive] = useState(tabs[0].id);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <motion.aside
      aria-label="Room panel"
      aria-hidden={!open}
      initial={false}
      animate={{ width: open ? 320 : 0 }}
      transition={spring.panel}
      className="shrink-0 overflow-hidden border-l border-line bg-surface-1"
    >
      <div className="flex w-[320px] flex-col gap-4 p-4">
        <div role="tablist" className="flex rounded-[11px] border border-line bg-surface-2 p-[3px]">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === current.id}
              onClick={() => setActive(t.id)}
              className={`relative isolate h-8 flex-1 rounded-lg text-[12.5px] font-medium transition-colors ${t.id === current.id ? "text-text" : "text-text-2 hover:text-text"}`}
            >
              {t.id === current.id && <motion.span layoutId="panel-tab" transition={spring.glide} className="absolute inset-0 -z-10 rounded-lg bg-[#1c2225]" />}
              {t.label}
            </button>
          ))}
        </div>
        {current.content}
      </div>
    </motion.aside>
  );
}
