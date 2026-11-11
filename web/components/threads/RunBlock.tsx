"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight, CircleAlert, CornerDownRight, Square, Wallet } from "lucide-react";
import { formatElapsed } from "@/lib/client/format";
import type { Mentionable } from "@/lib/client/mentions";
import { footerText, liveFooter } from "@/lib/client/models";
import { useModels } from "@/lib/client/ModelsProvider";
import { runRows, stepsLabel, type RunRow } from "@/lib/client/run";
import type { PendingMessage } from "@/lib/client/timeline";
import { useRunStream } from "@/lib/client/useRunStream";
import { dur, easeOut, instant, spring } from "@/lib/motion";
import type { Message, RunEndStatus } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";
import { AnswerText } from "./AnswerText";
import { ApprovalCard } from "./ApprovalCard";
import { RunningArc, StepRow } from "./StepRow";

type Props = {
  runId: string;
  /** The stored answer. Without one the run is shown from its live stream. */
  answer?: Message;
  steers: Message[];
  /** My steers still on their way to the server. */
  pending: PendingMessage[];
  /** The thread says this run is still going (the stream can lag a moment behind). */
  active: boolean;
  meName: string;
  members: Mentionable[];
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
};

const ENDINGS: Record<Exclude<RunEndStatus, "done">, { label: string; icon: typeof Square; tone: string }> = {
  stopped: { label: "Stopped", icon: Square, tone: "text-text-3" },
  failed: { label: "The run failed", icon: CircleAlert, tone: "text-text-3" },
  capped: { label: "The room's budget is used up", icon: Wallet, tone: "text-amber" },
};

/**
 * One run of the agent, under the message that started it. Live, it shows every step and steer as it happens and the
 * answer word by word. Once its answer is stored the rows fold into a "N steps" toggle (keyed by run, this is the
 * same component, so the fold animates), and opening it replays the run's events.
 */
export function RunBlock({ runId, answer, steers, pending, active, meName, members, onRetry, onDiscard }: Props) {
  const reduced = useReducedMotion();
  const { models } = useModels();
  const stored = answer?.agent;
  const [wanted, setWanted] = useState(!stored);
  const [open, setOpen] = useState(false);
  // Whether this block was live in front of me; then its toggle and footer arrive with a fade instead of being there.
  const [wasLive] = useState(!stored);
  const { run, unavailable } = useRunStream(wanted ? runId : undefined, !stored);

  const rows = runRows(run, steers, stored ? [] : pending);
  const loaded = run.lastSeq > 0;
  const status = stored?.status ?? (run.status === "running" ? undefined : run.status);
  // A step at work, or a write waiting on a member, is what the run is doing; it isn't thinking.
  const busy = rows.some((r) => (r.kind === "step" && r.step.status === "running") || (r.kind === "approval" && r.approval.status === "pending"));
  const thinking = !stored && active && !unavailable && run.status === "running" && !busy && !run.text;
  const showRows = stored ? open && (loaded || unavailable) : rows.length > 0 || unavailable || thinking;
  const text = answer?.text ?? run.text;
  const fade = (on: boolean) => ({
    initial: on && wasLive ? { opacity: 0 } : false,
    animate: { opacity: 1 },
    transition: reduced ? instant : { duration: dur.base, ease: easeOut },
  }) as const;

  function toggle() {
    setWanted(true);
    setOpen(!open);
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {stored && (stored.steps > 0 || steers.length > 0) && (
        <motion.button
          {...fade(true)}
          onClick={toggle}
          aria-expanded={open}
          className="-mx-2 flex h-8 w-fit items-center gap-1.5 rounded-lg px-2 font-mono text-[12px] text-text-3 transition-[background-color,color,transform] hover:bg-surface-2 hover:text-text active:scale-[0.97]"
        >
          {open && !loaded && !unavailable
            ? <Spinner />
            : <ChevronRight aria-hidden="true" size={14} className={`transition-transform duration-300 ${open ? "rotate-90" : ""}`} />}
          {stepsLabel(stored.steps, steers.length)}
        </motion.button>
      )}

      <AnimatePresence initial={false}>
        {showRows && (
          <motion.div
            key="rows"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? instant : { duration: dur.base, ease: easeOut }}
            className="flex flex-col gap-0.5 overflow-hidden"
          >
            {unavailable && <p className="px-3 text-[13px] text-text-3">This run&apos;s steps couldn&apos;t be loaded.</p>}
            {rows.map((row) => {
              if (row.kind === "step") return <StepRow key={row.key} step={row.step} enter={!stored} />;
              if (row.kind === "approval") return <ApprovalCard key={row.key} runId={runId} approval={row.approval} meName={meName} enter={!stored} />;
              return (
                <SteerBubble
                  key={row.key} row={row} mine={!row.authorName || row.authorName === meName} startedAt={run.startedAt}
                  enter={!stored} onRetry={onRetry} onDiscard={onDiscard}
                />
              );
            })}
            {thinking && (
              <div className="flex h-10 items-center gap-3 px-3">
                <span className="grid size-4 place-items-center"><RunningArc /></span>
                <span className="shimmer font-mono text-[12.5px]">thinking</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {text && <AnswerText text={text} streaming={!stored && run.status === "running"} members={members} />}

      {status && status !== "done" && <Ending status={status} reason={stored?.reason ?? run.reason} />}

      {stored
        ? <motion.p {...fade(true)} className="-mt-2 font-mono text-[11.5px] text-text-3">{footerText(stored, models)}</motion.p>
        : loaded && <p className="-mt-2 font-mono text-[11.5px] text-text-3">{liveFooter(run, models)}</p>}
    </div>
  );
}

function Ending({ status, reason }: { status: Exclude<RunEndStatus, "done">; reason?: string }) {
  const { label, icon: Icon, tone } = ENDINGS[status];
  return (
    <p role="status" className="flex items-start gap-2 text-[13px] text-text-2">
      <Icon aria-hidden="true" size={13} className={`mt-[3px] shrink-0 ${tone}`} fill={status === "stopped" ? "currentColor" : "none"} />
      {reason || label}
    </p>
  );
}

/**
 * A message sent to the running agent. It springs in when sent, waits as "queued" until the agent reads it between
 * steps, then turns lime where it landed among the steps. One the run ended without reading says "not read".
 */
function SteerBubble({ row, mine, startedAt, enter, onRetry, onDiscard }: {
  row: Extract<RunRow, { kind: "steer" }>; mine: boolean; startedAt?: string; enter: boolean;
  onRetry: (clientId: string) => void; onDiscard: (clientId: string) => void;
}) {
  const reduced = useReducedMotion();
  const read = row.state === "read";
  const steeredAt = read && startedAt && row.at ? ` at ${formatElapsed(Date.parse(row.at) - Date.parse(startedAt))}` : "";
  const label = { read: `steered${steeredAt}`, queued: "queued", unread: "not read", sending: "sending", failed: "" }[row.state];

  return (
    <motion.div
      initial={enter && !reduced ? { opacity: 0, y: 10, scale: 0.95 } : false}
      animate={{ opacity: row.state === "sending" ? 0.6 : 1, y: 0, scale: 1 }}
      transition={reduced ? instant : spring.pop}
      className="my-1.5 flex max-w-[85%] flex-col items-end gap-1 self-end"
    >
      <div
        className={`flex items-center gap-2 rounded-xl border px-3 py-[7px] text-[13px] transition-colors duration-300 ${
          read ? "border-[#2f4a1e] bg-[#172014]" : row.state === "failed" ? "border-[#4a3e1c] bg-surface-2" : "border-line-strong bg-surface-2"
        }`}
      >
        <CornerDownRight aria-hidden="true" size={13} strokeWidth={2.4} className={`shrink-0 transition-colors duration-300 ${read ? "text-lime" : "text-text-3"}`} />
        <span className="min-w-0 break-words">
          {!mine && <b className="mr-1.5 font-semibold">{row.authorName}</b>}
          {row.text}
        </span>
        {label && <span className="shrink-0 font-mono text-[11px] text-text-2">{label}</span>}
      </div>
      {row.state === "failed" && row.clientId && (
        <div className="flex items-center gap-2 px-1 text-[12px]">
          <CircleAlert aria-hidden="true" size={13} className="text-amber" />
          <span className="text-amber">Not sent</span>
          <button onClick={() => onRetry(row.clientId!)} className="text-text-2 underline-offset-2 transition-colors hover:text-text hover:underline">Retry</button>
          <button onClick={() => onDiscard(row.clientId!)} className="text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline">Discard</button>
        </div>
      )}
    </motion.div>
  );
}
