"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { formatElapsed, formatUsd } from "@/lib/client/format";
import { timeShares } from "@/lib/client/runMap";
import { easeOut } from "@/lib/motion";
import type { RunEvent } from "@/lib/types";

/** What one turn on the Map adds to the thread's totals. */
export type TurnSummary = { events: RunEvent[]; steps: number; helpers: number; ms: number; costMicros: number };

export const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * The thread's totals over the turns shown, and one bar for where their time (or money) went. The time and cost
 * figures are the switch for what the bar measures, so the strip needs no label or toggle of its own. Counts that are
 * zero are left out.
 */
export function MapSummary({ turns, summaries }: { turns: number; summaries: TurnSummary[] }) {
  const reduced = useReducedMotion();
  const [by, setBy] = useState<"time" | "cost">("time");
  const shares = timeShares(summaries.map((s) => s.events), by);
  const total = (key: "steps" | "helpers" | "ms" | "costMicros") => summaries.reduce((sum, s) => sum + s[key], 0);
  const [steps, helpers] = [total("steps"), total("helpers")];
  const counts = [plural(turns, "turn"), steps && plural(steps, "step"), helpers && plural(helpers, "helper")].filter(Boolean).join(" · ");
  const figures = { time: formatElapsed(total("ms")), cost: formatUsd(total("costMicros")) };

  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-2 sm:px-[22px]">
      <p suppressHydrationWarning className="font-mono text-[12px] tabular-nums text-text-3">
        <span>{counts}</span>
        {summaries.length > 0 && (["time", "cost"] as const).map((b) => (
          <span key={b}>
            <span aria-hidden="true" className="text-text-4"> · </span>
            <button
              onClick={() => setBy(b)}
              aria-pressed={by === b}
              aria-label={`${b}: ${figures[b]}`}
              title={`Split the bar by ${b}`}
              className={`rounded-sm underline-offset-[5px] transition-colors ${by === b ? "text-text underline decoration-line-hover" : "hover:text-text"}`}
            >
              {figures[b]}
            </button>
          </span>
        ))}
      </p>
      <motion.span
        role="img"
        aria-label={shares.map((s) => `${s.label} ${s.pct}%`).join(", ") || "nothing yet"}
        initial={reduced ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.5, ease: easeOut }}
        className="flex h-1 w-[140px] shrink-0 origin-left overflow-hidden rounded-full bg-surface-4"
      >
        {shares.map((s) => <span key={s.key} className="h-full transition-[width] duration-300" style={{ width: `${s.pct}%`, background: s.color }} />)}
      </motion.span>
      <span className="flex gap-2.5 text-[11.5px] text-text-3">
        {shares.map((s) => (
          <span key={s.key} className="flex items-center gap-1">
            <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
            <span className="font-mono tabular-nums">{s.pct}%</span>
          </span>
        ))}
      </span>
    </div>
  );
}
