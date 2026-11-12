"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { formatElapsed, formatStepTime } from "@/lib/client/format";
import { splitSyncLines, type RunItem } from "@/lib/client/run";
import { useNow } from "@/lib/client/useNow";
import { dur, easeOut, instant, spring } from "@/lib/motion";
import { GeneratedImage } from "./GeneratedImage";

type Step = Extract<RunItem, { kind: "step" }>;

/** Agent work in progress: an arc turning once every 0.8 s (static under reduced motion). */
export function RunningArc({ size = 15 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-[spin_.8s_linear_infinite] text-lime motion-reduce:animate-none">
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

/**
 * One tool call. While it runs: a turning arc, its name shimmering and the time ticking. When it finishes the check
 * pops and the row flashes once; a finished row opens to show what the tool returned. `enter`: it appeared during
 * the run, so it slides in (rows revealed by expanding a finished run come in with their list instead).
 * A step handed to a helper agent is one row in the helper's name, with what it found; it opens, even while the helper
 * works, onto the helper's own steps and then its answer.
 */
export function StepRow({ roomId, step, enter }: { roomId: string; step: Step; enter: boolean }) {
  const reduced = useReducedMotion();
  const outputId = useId();
  const running = step.status === "running";
  const helper = step.helper;
  const opens = !running || !!helper;
  // Only a step seen running finishes in front of you; one that arrives finished gets no pop or flash.
  const [seenRunning] = useState(running);
  const [open, setOpen] = useState(false);
  const now = useNow(running);
  const ended = !running && seenRunning;
  const { output, lines } = step.files ? splitSyncLines(step.output ?? "", step.files) : { output: step.output, lines: [] };

  return (
    <motion.div
      initial={enter ? { opacity: 0, x: reduced ? 0 : -10 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={reduced ? instant : { duration: 0.4, ease: easeOut }}
    >
      <button
        onClick={() => setOpen(!open)}
        disabled={!opens}
        aria-expanded={opens ? open : undefined}
        aria-controls={opens ? outputId : undefined}
        className="relative isolate flex h-10 w-full items-center gap-3 overflow-hidden rounded-[10px] px-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-offset-[-2px] disabled:cursor-default disabled:hover:bg-transparent"
      >
        {ended && (
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={reduced ? instant : { duration: 0.5, ease: easeOut }}
            className="absolute inset-0 -z-10 bg-lime-flash"
          />
        )}
        <span className="grid size-4 shrink-0 place-items-center">
          {running
            ? <RunningArc />
            : (
              <motion.svg
                aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8"
                initial={ended && !reduced ? { scale: 0.2, rotate: -20, opacity: 0 } : false}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={spring.pop}
                className={step.status === "failed" ? "text-amber" : "text-lime"}
              >
                <path d={step.status === "failed" ? "M18 6 6 18M6 6l12 12" : "m5 12 4.5 4.5L19 7"} />
              </motion.svg>
            )}
        </span>
        <span className={`shrink-0 font-mono text-[12.5px] ${running ? "shimmer" : ""}`}>{helper?.agentName ?? step.name}</span>
        <span className="min-w-0 truncate text-[12.5px] text-text-2">{helper ? helper.summary ?? helper.task : step.detail}</span>
        <span className={`ml-auto shrink-0 font-mono text-[11.5px] tabular-nums ${running ? "text-lime" : step.status === "failed" ? "text-amber" : "text-text-3"}`}>
          {running ? formatElapsed(now - Date.parse(step.startedAt)) : step.status === "failed" ? "failed" : formatStepTime(step.ms ?? 0)}
        </span>
        <ChevronRight
          aria-hidden="true" size={13}
          className={`shrink-0 text-text-4 transition-[transform,opacity] duration-300 ${open ? "rotate-90" : ""} ${opens ? "" : "opacity-0"}`}
        />
        <span className="sr-only">{running ? ", running" : step.status === "failed" ? ", failed" : ", done"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && opens && (
          <motion.div
            id={outputId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: reduced ? instant : { height: { duration: 0.4, ease: easeOut }, opacity: { duration: dur.base } } }}
            exit={{ height: 0, opacity: 0, transition: reduced ? instant : { height: { duration: dur.base, ease: easeOut }, opacity: { duration: dur.fast } } }}
            className="overflow-hidden"
          >
            {helper && (
              <div className="ml-[22px] border-l border-line pl-2">
                {helper.items.map((i) => (i.kind === "step" ? <StepRow key={i.step} roomId={roomId} step={i} enter={enter} /> : null))}
              </div>
            )}
            {!running && (
              <pre className="mb-2 ml-10 mr-3 mt-0.5 whitespace-pre-wrap break-words rounded-[10px] border border-line bg-output px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-output-text">
                {output || "No output."}
              </pre>
            )}
            {step.image && <div className="mb-2 ml-10 mr-3"><GeneratedImage roomId={roomId} image={step.image} /></div>}
            {lines.map((line) => <p key={line} className="mb-1 ml-10 mr-3 break-words text-[12px] text-text-3">{line}</p>)}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
