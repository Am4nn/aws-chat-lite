"use client";

import { formatUsd } from "@/lib/client/format";
import { runElapsed } from "@/lib/client/threads";
import { useNow } from "@/lib/client/useNow";
import type { ThreadSummary } from "@/lib/types";

/** The room panel's view of this thread's latest run: how many steps, how long and what it cost so far. */
export function RunPanel({ thread: t }: { thread: ThreadSummary }) {
  const now = useNow(t.status === "running");
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11.5px] font-semibold text-text-3">This run</h2>
      {t.runId
        ? (
          <dl className="grid grid-cols-3 gap-2">
            <Tile label="steps" value={String(t.steps)} />
            <Tile label="elapsed" value={runElapsed(t, now)} />
            <Tile label="cost" value={formatUsd(t.costMicros)} />
          </dl>
        )
        : <p className="text-[12.5px] text-text-3">Nothing has run here yet.</p>}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col-reverse rounded-[10px] bg-surface-2 p-2.5">
      <dt className="text-[11px] text-text-3">{label}</dt>
      <dd suppressHydrationWarning className="font-mono text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}
