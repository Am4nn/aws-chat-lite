"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ThreadRun } from "@/lib/client/threadRuns";

const STEP = "grid size-7 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text";

/** Which of the thread's runs the Map shows, with the ones either side a click away. Nothing for a single run. */
export function RunSwitcher({ runs, shown }: { runs: ThreadRun[]; shown: string }) {
  const pathname = usePathname();
  const at = runs.findIndex((r) => r.runId === shown);
  if (runs.length < 2 || at < 0) return null;
  const href = (r: ThreadRun | undefined) => (r ? `${pathname}?view=map&run=${r.runId}` : undefined);

  const step = (label: string, target: ThreadRun | undefined, icon: React.ReactNode) =>
    target
      ? <Link href={href(target)!} scroll={false} aria-label={label} title={target.prompt || label} className={STEP}>{icon}</Link>
      : <span aria-label={label} aria-disabled="true" className={`${STEP} pointer-events-none opacity-40`}>{icon}</span>;

  return (
    <div className="flex min-w-0 items-center gap-1">
      {step("Earlier run", runs[at - 1], <ChevronLeft aria-hidden="true" size={14} />)}
      <p className="min-w-0 truncate text-[12.5px] text-text-3">
        <span className="font-mono tabular-nums text-text">Run {at + 1} of {runs.length}</span>
        {runs[at].prompt && <> · {runs[at].prompt}</>}
      </p>
      {step("Later run", runs[at + 1], <ChevronRight aria-hidden="true" size={14} />)}
    </div>
  );
}
