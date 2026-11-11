"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight, Clock, Square, X } from "lucide-react";
import { decider, remaining, sendDecision, settledLine, type LocalDecision } from "@/lib/client/approvals";
import type { ApprovalItem } from "@/lib/client/run";
import type { ApprovalStatus } from "@/lib/types";
import { useNow } from "@/lib/client/useNow";
import { dur, easeOut, instant, spring } from "@/lib/motion";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/overlays/Toast";

const GROW = { duration: 0.5, ease: easeOut };
const EXPIRY_TICK_MS = 15_000;

type Props = {
  runId: string;
  approval: ApprovalItem;
  meName: string;
  /** It appeared during the run, so it grows in; one in a replayed run is just there. */
  enter: boolean;
};

/**
 * A write the agent wants to make, or a web call from a thread with private content, waiting for any member. Details shows the exact input that will run. A decision
 * shows at once; the card then shrinks into a one-line record of how it settled, which the run's own
 * `approval.settled` confirms (or, after a 409, supplies).
 */
export function ApprovalCard({ runId, approval: a, meName, enter }: Props) {
  const reduced = useReducedMotion();
  const toast = useToast();
  const [local, setLocal] = useState<LocalDecision>(null);
  const [decide] = useState(() => decider(
    (decision) => sendDecision(runId, a.step, decision),
    setLocal,
    (text) => toast(text, "error"),
  ));
  // Only an approval seen pending settles in front of me, so only that one pops its mark.
  const [seenPending] = useState(a.status === "pending");
  const now = useNow(a.status === "pending", EXPIRY_TICK_MS);

  const mine = local && "decision" in local
    ? { status: local.decision === "approve" ? "approved" as const : "denied" as const, by: meName }
    : null;
  const settled = a.status === "pending" ? mine : { status: a.status, by: a.by, stoppedFirst: a.stoppedFirst };
  const kind = a.call.name.startsWith("web_") ? "web call from a private thread" : "write action";
  const conflict = local && "conflict" in local ? local.conflict : null;

  return (
    <motion.div
      initial={enter && !reduced ? { height: 0, opacity: 0 } : false}
      animate={{ height: "auto", opacity: 1 }}
      transition={reduced ? instant : GROW}
      className="overflow-hidden"
    >
      <AnimatePresence mode="wait" initial={false}>
        {settled
          ? (
            <motion.div
              key="settled"
              role="status"
              initial={reduced ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              transition={reduced ? instant : GROW}
              className="overflow-hidden"
            >
              <SettledRow status={settled.status} line={settledLine(settled, meName)} pop={seenPending && !reduced} />
            </motion.div>
          )
          : (
            <motion.div
              key="card"
              exit={{ height: 0, opacity: 0, transition: reduced ? instant : { duration: dur.base, ease: easeOut } }}
              className="overflow-hidden"
            >
              <div className="my-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-3 rounded-[14px] border border-[#4a3e1c] bg-[#17150e] px-4 py-3.5">
                <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-amber text-amber-ink">
                  <svg aria-hidden="true" width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                    <path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" />
                  </svg>
                </span>
                <div className="min-w-[180px] flex-1">
                  <p className="break-words text-[14px] font-semibold">{a.title}</p>
                  <p role={conflict ? "status" : undefined} className="text-[12.5px] text-[#b9ae93]" suppressHydrationWarning>
                    {conflict ?? `${kind} · anyone in the room can approve · expires in ${remaining(a.expiresAt, now)}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 max-sm:basis-full max-sm:justify-end">
                  <Button disabled={!!conflict} onClick={() => void decide("deny")} className="h-8 text-[12.5px]">Deny</Button>
                  <Button variant="amber" disabled={!!conflict} onClick={() => void decide("approve")} className="h-8 text-[12.5px]">Approve</Button>
                </div>
                <details className="group w-full">
                  <summary className="flex h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[12px] text-[#b9ae93] transition-colors hover:text-text [&::-webkit-details-marker]:hidden">
                    <ChevronRight aria-hidden="true" size={13} className="transition-transform duration-300 group-open:rotate-90" />
                    Details
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-[#2a2414] bg-[#0f0e09] px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-[#d8ceb4]">
                    {JSON.stringify(a.call.input, null, 2)}
                  </pre>
                </details>
              </div>
            </motion.div>
          )}
      </AnimatePresence>
    </motion.div>
  );
}

const ICONS = { denied: X, expired: Clock, cancelled: Square };

function SettledRow({ status, line, pop }: { status: Exclude<ApprovalStatus, "pending">; line: string; pop: boolean }) {
  if (status === "approved") {
    return (
      <div className="my-1.5 flex items-center gap-2.5 rounded-[14px] border border-[#34501c] bg-[#111a0c] px-4 py-3 text-[13.5px] text-[#ddf5b5]">
        <motion.svg
          aria-hidden="true" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8"
          initial={pop ? { scale: 0.2, rotate: -20, opacity: 0 } : false}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={spring.pop}
          className="shrink-0 text-lime"
        >
          <path d="m5 12 4.5 4.5L19 7" />
        </motion.svg>
        {line}
      </div>
    );
  }
  const Icon = ICONS[status];
  return (
    <div className="my-1.5 flex items-center gap-2.5 rounded-[14px] border border-line-strong bg-surface-2 px-4 py-3 text-[13.5px] text-text-2">
      <Icon aria-hidden="true" size={15} className="shrink-0 text-text-3" fill={status === "cancelled" ? "currentColor" : "none"} />
      {line}
    </div>
  );
}
