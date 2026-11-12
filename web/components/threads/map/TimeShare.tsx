"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { timeShares } from "@/lib/client/runMap";
import { easeOut, instant, spring } from "@/lib/motion";
import type { RunEvent } from "@/lib/types";

/**
 * "Where the time went": one bar split between thinking, helpers, tools and waiting, by time or by cost. The bar grows
 * in from the left, and switching what it measures slides its parts to their new widths.
 */
export function TimeShare({ events }: { events: RunEvent[] }) {
  const reduced = useReducedMotion();
  const [by, setBy] = useState<"time" | "cost">("time");
  const shares = timeShares(events, by);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[11.5px] font-semibold tracking-[.02em] text-text-3">Where the time went</span>
      <div role="group" aria-label="Measure" className="flex rounded-lg border border-line bg-surface-2 p-0.5">
        {(["time", "cost"] as const).map((b) => (
          <button
            key={b}
            onClick={() => setBy(b)}
            aria-pressed={by === b}
            className={`relative isolate h-6 rounded-md px-2 text-[11.5px] capitalize transition-colors ${by === b ? "text-text" : "text-text-3 hover:text-text"}`}
          >
            {by === b && <motion.span layoutId="time-share-by" transition={reduced ? instant : spring.glide} className="absolute inset-0 -z-10 rounded-md bg-surface-4" />}
            {b}
          </button>
        ))}
      </div>
      <motion.span
        role="img"
        aria-label={shares.map((s) => `${s.label} ${s.pct}%`).join(", ") || "nothing yet"}
        initial={reduced ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.5, ease: easeOut }}
        className="flex h-1.5 w-[200px] origin-left overflow-hidden rounded-full bg-surface-4 max-sm:w-full"
      >
        {shares.map((s) => <span key={s.key} className="h-full transition-[width] duration-300" style={{ width: `${s.pct}%`, background: s.color }} />)}
      </motion.span>
      <span className="flex gap-2.5 text-[11.5px] text-text-3">
        {shares.map((s) => (
          <span key={s.key} className="flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: s.color }} />{s.label}</span>
        ))}
      </span>
    </div>
  );
}
