"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { decider, sendDecision, settledLine, type LocalDecision } from "@/lib/client/approvals";
import { formatElapsed, formatStepCost, formatStepTime, formatTokens } from "@/lib/client/format";
import { runMap, type MapNode } from "@/lib/client/runMap";
import { useNow } from "@/lib/client/useNow";
import { useRunStream } from "@/lib/client/useRunStream";
import { dur, easeOut, instant } from "@/lib/motion";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/overlays/Toast";
import type { PickedStep } from "./stepPick";

const STATUS: Record<MapNode["status"], { label: string; tone: string }> = {
  running: { label: "running", tone: "text-lime" },
  done: { label: "done", tone: "text-lime" },
  failed: { label: "failed", tone: "text-amber" },
  waiting: { label: "needs approval", tone: "text-amber" },
};

/**
 * The room panel's view of a step picked on the Map: when it started, how long it took, its share of the tokens and
 * cost, and what it returned. A step waiting on a member can be approved or denied from here.
 */
export function StepDetails({ runId, nodeId, live }: PickedStep) {
  const reduced = useReducedMotion();
  const { run } = useRunStream(runId, live);
  const now = useNow(live && run.status === "running");
  const map = runMap(run.events, now);
  const node = map.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const status = STATUS[node.status];
  const took = node.kind === "ask" || node.kind === "steer" ? "—" : formatStepTime(node.ms ?? 0);

  return (
    <motion.section
      key={nodeId}
      aria-label="Step details"
      initial={reduced ? false : { opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={reduced ? instant : { duration: dur.base, ease: easeOut }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <p className="text-[11.5px] font-semibold text-text-3">{map.lanes.find((l) => l.lane === node.lane)?.label}</p>
        <p className="flex items-baseline gap-2.5">
          <span className="min-w-0 break-words font-mono text-base font-medium">{node.name}</span>
          <span className={`ml-auto shrink-0 text-[12px] ${status.tone}`}>{status.label}</span>
        </p>
        {node.detail && <p className="break-words text-[13px] text-text-2">{node.detail}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-2">
        <Tile label="started" value={formatElapsed(node.startedMs)} />
        <Tile label="took" value={took} />
        <Tile label="tokens" value={node.tokens ? formatTokens(node.tokens) : "—"} />
        <Tile label="cost" value={node.costMicros ? formatStepCost(node.costMicros) : "—"} />
      </dl>
      {node.approval && <Approval runId={runId} step={node.step!} approval={node.approval} />}
      {(node.output || node.file) && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[11.5px] font-semibold text-text-3">Output</h3>
          {node.output && (
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-output px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-output-text">
              {node.output}
            </pre>
          )}
          {node.file && <p className="truncate text-[12px] text-lime">↳ saved {node.file}</p>}
        </div>
      )}
    </motion.section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col-reverse rounded-[10px] bg-surface-2 p-2.5">
      <dt className="text-[11px] text-text-3">{label}</dt>
      <dd suppressHydrationWarning className="font-mono text-[15px] tabular-nums">{value}</dd>
    </div>
  );
}

/** Approve or Deny, as on the Timeline's card: my decision shows at once, and the run's settlement replaces it. */
function Approval({ runId, step, approval }: { runId: string; step: number; approval: NonNullable<MapNode["approval"]> }) {
  const toast = useToast();
  const [local, setLocal] = useState<LocalDecision>(null);
  const [decide] = useState(() => decider((d) => sendDecision(runId, step, d), setLocal, (text) => toast(text, "error")));

  if (approval.status !== "pending") return <p role="status" className="text-[13px] text-text-2">{settledLine({ ...approval, status: approval.status })}</p>;
  if (local && "conflict" in local) return <p role="status" className="text-[13px] text-text-2">{local.conflict}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="break-words text-[13px] font-semibold">{approval.title}</p>
      <div className="flex gap-2">
        <Button disabled={!!local} onClick={() => void decide("deny")} className="h-8 flex-1 text-[12.5px]">Deny</Button>
        <Button variant="amber" disabled={!!local} onClick={() => void decide("approve")} className="h-8 flex-1 text-[12.5px]">Approve</Button>
      </div>
    </div>
  );
}
