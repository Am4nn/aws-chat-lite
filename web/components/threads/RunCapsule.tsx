"use client";

import { motion, useReducedMotion } from "motion/react";
import { isLive, runLabel, runMeta } from "@/lib/client/threads";
import { useNow } from "@/lib/client/useNow";
import { instant } from "@/lib/motion";
import type { ThreadSummary } from "@/lib/types";
import { ThreadStatusIcon } from "./ThreadStatusIcon";

const BORDER: Record<string, string> = { running: "border-line-strong", waiting: "border-amber-line", done: "border-lime-line" };

/**
 * The thread's run in the header: what it's doing and for how long, then how it ended. Honest progress only: state,
 * step count and time, never a bar. Screen readers hear the state and step count change, not every second tick.
 */
export function RunCapsule({ thread: t }: { thread: ThreadSummary }) {
  const reduced = useReducedMotion();
  const running = t.status === "running";
  const now = useNow(isLive(t.status));
  const label = runLabel(t);

  return (
    <motion.div
      role="status"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduced ? instant : { duration: 0.25 }}
      className={`flex h-9 shrink-0 items-center gap-2.5 rounded-[18px] border bg-black pl-[9px] pr-3.5 transition-[border-color] duration-[400ms] max-md:pr-3 ${BORDER[t.status] ?? "border-line-hover"}`}
    >
      <ThreadStatusIcon status={t.status} size={18} done="text-lime" track />
      <span aria-hidden="true" className={`max-w-[220px] truncate text-[12.5px] font-medium max-md:hidden ${running ? "shimmer" : t.status === "waiting" ? "text-amber" : ""}`}>{label}</span>
      <span aria-hidden="true" suppressHydrationWarning className="whitespace-nowrap font-mono text-[12px] tabular-nums text-text-3">{runMeta(t, now)}</span>
      <span className="sr-only">{`${label}, ${t.steps} ${t.steps === 1 ? "step" : "steps"}`}</span>
    </motion.div>
  );
}
