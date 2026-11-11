"use client";

import { ArrowUpRight } from "lucide-react";
import { runFiles } from "@/lib/client/files";
import { formatUsd } from "@/lib/client/format";
import { modelLabel } from "@/lib/client/models";
import { useModels } from "@/lib/client/ModelsProvider";
import { isLive, runElapsed } from "@/lib/client/threads";
import { useNow } from "@/lib/client/useNow";
import { useRunStream } from "@/lib/client/useRunStream";
import type { RoomFile, Source, ThreadSummary } from "@/lib/types";

/**
 * The room panel's view of this thread's latest run: how many steps, how long and what it cost so far, the room files
 * it wrote and what it read on the web.
 */
export function RunPanel({ thread: t, files }: { thread: ThreadSummary; files: RoomFile[] }) {
  const live = isLive(t.status);
  const now = useNow(live);
  const { run } = useRunStream(t.runId, live);
  const written = t.runId ? runFiles(files, t) : [];
  const { models } = useModels();
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-[11.5px] font-semibold text-text-3">This run</h2>
        {t.runId
          ? (
            <>
              <dl className="grid grid-cols-3 gap-2">
                <Tile label="steps" value={String(t.steps)} />
                <Tile label="elapsed" value={runElapsed(t, now)} />
                <Tile label="cost" value={formatUsd(t.costMicros)} />
              </dl>
              {t.model && (
                <dl className="flex items-baseline justify-between rounded-[10px] bg-surface-2 px-2.5 py-2">
                  <dt className="text-[11px] text-text-3">Model</dt>
                  <dd className="font-mono text-[12.5px]">{modelLabel(models, t.model)}</dd>
                </dl>
              )}
            </>
          )
          : <p className="text-[12.5px] text-text-3">Nothing has run here yet.</p>}
        {written.length > 0 && (
          <>
            <h2 className="mt-2 text-[11.5px] font-semibold text-text-3">Files</h2>
            <ul className="flex flex-col gap-1">
              {written.map((path) => <li key={path} title={path} className="truncate font-mono text-[12px] text-text-2">{path}</li>)}
            </ul>
          </>
        )}
      </section>
      {run.sources.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="pb-1 text-[11.5px] font-semibold text-text-3">Sources</h2>
          <ul className="flex flex-col gap-0.5">
            {run.sources.map((s) => <SourceRow key={s.url} source={s} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function SourceRow({ source }: { source: Source }) {
  return (
    <li className="animate-[row-in_.45s_cubic-bezier(.2,.9,.2,1)_both] motion-reduce:animate-none">
      <a
        href={source.url} target="_blank" rel="noopener noreferrer"
        className="group flex items-start gap-2 rounded-[10px] px-2.5 py-2 transition-colors hover:bg-surface-2 active:bg-surface-3"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text">{source.title || hostOf(source.url)}</span>
          <span className="block truncate font-mono text-[11px] text-text-3">{hostOf(source.url)}</span>
        </span>
        <ArrowUpRight aria-hidden="true" size={14} className="mt-0.5 shrink-0 text-text-3 transition-colors group-hover:text-text" />
      </a>
    </li>
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
