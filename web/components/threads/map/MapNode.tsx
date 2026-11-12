"use client";

import { motion, useReducedMotion } from "motion/react";
import { formatElapsed, formatStepCost, formatStepTime } from "@/lib/client/format";
import type { MapNode as Node } from "@/lib/client/runMap";
import { RunningArc } from "../StepRow";

/** Cards drop in with a slight overshoot. */
const DROP = { duration: 0.45, ease: [0.2, 1.15, 0.4, 1] } as const;

const LOOK = {
  selected: "border-lime bg-lime-wash",
  waiting: "border-amber-line bg-amber-wash hover:border-amber/40",
  other: "border-line-strong bg-surface-2 hover:border-line-hover",
};

/**
 * One step on the Map: its name and state, what it took and cost, and the files it saved. A running step's name
 * shimmers beside a turning arc while its time ticks; a step waiting on a member says so in amber. The drop-in is on
 * a wrapper, so the card's own hover lift never waits for the drop-in's delay.
 */
export function MapNode({ node: n, selected, delay, onPick }: { node: Node; selected: boolean; delay: number; onPick: () => void }) {
  const reduced = useReducedMotion();
  const waiting = n.status === "waiting";
  const running = n.status === "running";
  const timed = n.kind === "tool" || n.kind === "answer";
  const meta = waiting ? "needs approval"
    : running ? formatStepTime(n.ms ?? 0)
    : timed ? `${formatStepTime(n.ms ?? 0)} · ${formatStepCost(n.costMicros ?? 0)}`
    : `at ${formatElapsed(n.startedMs)}`;

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...DROP, delay }}
      style={{ left: n.x, top: n.y }}
      className="absolute"
    >
      <button
        onClick={onPick}
        aria-pressed={selected}
        className={`block h-[72px] w-[108px] rounded-xl border px-2.5 py-[9px] text-left transition-[border-color,background-color,box-shadow,translate,scale] duration-200 hover:-translate-y-0.5 active:scale-[0.97] ${LOOK[selected ? "selected" : waiting ? "waiting" : "other"]}`}
      >
        <span className="flex items-center gap-1.5">
          <span className="grid size-3 shrink-0 place-items-center"><StateMark status={n.status} /></span>
          <span className={`truncate font-mono text-[11.5px] ${running ? "shimmer" : ""}`}>{n.name}</span>
        </span>
        <span suppressHydrationWarning className={`mt-[3px] block whitespace-nowrap font-mono text-[10.5px] tabular-nums ${running ? "text-lime" : waiting ? "text-amber" : "text-text-3"}`}>
          {meta}
        </span>
        {(n.file || waiting) && (
          <span className={`mt-1 block truncate text-[10.5px] ${waiting ? "text-amber" : "text-lime"}`}>{waiting ? "Approve or deny" : `↳ ${n.file}`}</span>
        )}
        <span className="sr-only">{`, ${waiting ? "waiting for approval" : n.status}`}</span>
      </button>
    </motion.div>
  );
}

function StateMark({ status }: { status: Node["status"] }) {
  if (status === "running") return <RunningArc size={12} />;
  if (status === "waiting") return <span className="size-[7px] rounded-full bg-amber" />;
  const failed = status === "failed";
  return (
    <svg aria-hidden="true" width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" className={failed ? "text-amber" : "text-lime"}>
      <path d={failed ? "M12 5v9M12 18.5v.5" : "m5 12 4.5 4.5L19 7"} />
    </svg>
  );
}
