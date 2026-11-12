"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { instant } from "@/lib/motion";
import type { ThreadStatus } from "@/lib/types";

const CROSSFADE = { duration: 0.15 };

/**
 * A thread's state at a glance: a turning arc while it works, an amber dot while it needs someone, a check once done,
 * a small square when it stopped any other way (or hasn't run). A change crossfades in place, so the row around it never
 * moves.
 */
export function ThreadStatusIcon({ status, size = 14, done = "text-sky", track = false }: {
  status: ThreadStatus; size?: number; done?: string;
  /** Draws the arc's full circle faintly behind it, for the larger header capsule. */
  track?: boolean;
}) {
  const reduced = useReducedMotion();
  const kind = status === "running" || status === "waiting" || status === "done" ? status : "still";
  return (
    <span className="grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <AnimatePresence initial={false}>
        <motion.span
          key={kind}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? instant : CROSSFADE}
          className="col-start-1 row-start-1 grid place-items-center"
        >
          {kind === "running" && (
            <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="3" strokeLinecap="round" className="animate-[spin_.8s_linear_infinite] motion-reduce:animate-none">
              {track && <circle cx="12" cy="12" r="9" stroke="var(--color-line-strong)" />}
              <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--color-lime)" />
            </svg>
          )}
          {kind === "done" && (
            <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" className={done}>
              <path d="m5 12 4.5 4.5L19 7" />
            </svg>
          )}
          {kind === "waiting" && <span aria-hidden="true" className="block rounded-full bg-amber" style={{ width: size * 0.56, height: size * 0.56 }} />}
          {kind === "still" && <span aria-hidden="true" className="block rounded-[2px] bg-text-3" style={{ width: size * 0.5, height: size * 0.5 }} />}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
