"use client";

import { useContext, useMemo, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { formatElapsed, formatUsd } from "@/lib/client/format";
import { runMap, type RunMap as Layout } from "@/lib/client/runMap";
import { isLive } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { useNow } from "@/lib/client/useNow";
import { useRunStream } from "@/lib/client/useRunStream";
import { threadRuns } from "@/lib/client/threadRuns";
import type { Message, ThreadSummary } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";
import { MapEdges } from "./MapEdges";
import { MapNode } from "./MapNode";
import { RunSwitcher } from "./RunSwitcher";
import { StepPick } from "./stepPick";
import { TimeShare } from "./TimeShare";

const STAGGER_S = 0.15;
const MAX_DELAY_S = 1.5;

/**
 * A thread's Map page: the run named in the address, else its latest, which the thread's live status keeps current,
 * with a switcher through the thread's other runs.
 */
export function ThreadMap({ thread: initial, runId, messages }: { thread: ThreadSummary; runId?: string; messages: Message[] }) {
  const thread = useThreads().byId(initial.threadId) ?? initial;
  const shown = runId ?? thread.runId;
  if (!shown) return <p className="p-7 text-[13.5px] text-text-3">Nothing has run here yet.</p>;
  return (
    <RunMap
      key={shown} runId={shown} live={isLive(thread.status) && shown === thread.runId}
      switcher={<RunSwitcher runs={threadRuns(messages, thread.runId)} shown={shown} />}
    />
  );
}

/**
 * One run as a map: a bar with its step count, helpers, time and cost and where that time went, then a lane per agent
 * with a card per step. It scrolls inside its own box, so a phone never scrolls the page sideways, and the lane
 * labels stay in view. Replay draws it in again from the start.
 */
export function RunMap({ runId, live, switcher }: { runId: string; live: boolean; switcher?: ReactNode }) {
  const { run, unavailable } = useRunStream(runId, live);
  const running = live && run.status === "running";
  const now = useNow(running);
  const map = useMemo(() => runMap(run.events, now), [run.events, now]);
  const [replays, setReplays] = useState(0);

  if (unavailable) return <p className="p-7 text-[13.5px] text-text-3">This run&apos;s steps couldn&apos;t be loaded.</p>;
  if (!run.lastSeq) return <div className="grid h-full place-items-center"><Spinner /></div>;

  const steps = map.nodes.filter((n) => n.kind === "tool").length;
  const helpers = map.lanes.length - 1;
  const elapsed = (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt ?? run.events[0].at);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-3 sm:px-[22px]">
        {switcher}
        <p suppressHydrationWarning className="font-mono text-[12.5px] tabular-nums text-text-3">
          <b className="font-normal text-text">{steps}</b> {steps === 1 ? "step" : "steps"}
          {" · "}<b className="font-normal text-text">{helpers}</b> {helpers === 1 ? "helper" : "helpers"}
          {" · "}<b className="font-normal text-text">{formatElapsed(elapsed)}</b>
          {" · "}<b className="font-normal text-text">{formatUsd(run.costMicros)}</b>
        </p>
        <div className="sm:ml-auto"><TimeShare events={run.events} /></div>
        <button
          onClick={() => setReplays((n) => n + 1)}
          className="flex h-8 items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface-2 px-3 text-[12.5px] text-text-2 transition-[border-color,color,transform] hover:border-line-hover hover:text-text active:scale-[0.96]"
        >
          <Play aria-hidden="true" size={12} fill="currentColor" />
          Replay
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
        <MapCanvas key={replays} map={map} runId={runId} live={live} />
      </div>
    </div>
  );
}

/**
 * The lanes, edges and cards. The cards there on the first paint drop in one after another; one that arrives later
 * drops in alone. Remounting (Replay) starts the cascade over.
 */
function MapCanvas({ map, runId, live }: { map: Layout; runId: string; live: boolean }) {
  const { picked, pick } = useContext(StepPick);
  const [first, setFirst] = useState<string[] | null>(null);
  if (!first && map.nodes.length) setFirst(map.nodes.map((n) => n.id));
  const delayOf = (nodeId: string) => {
    const i = first?.indexOf(nodeId) ?? -1;
    return i < 0 ? 0 : Math.min(i * STAGGER_S, MAX_DELAY_S);
  };
  const selected = picked?.runId === runId ? picked.nodeId : null;

  return (
    <div className="relative min-w-full" style={{ width: map.width, height: map.height }}>
      {map.lanes.map((l) => (
        <div key={l.lane} className="pointer-events-none absolute inset-x-4 rounded-2xl bg-surface-1" style={{ top: l.top, height: l.height }}>
          <span className="sticky left-4 inline-block px-4 pt-3.5 text-[11.5px] font-semibold tracking-[.02em] text-text-3">{l.label}</span>
        </div>
      ))}
      <MapEdges edges={map.edges} width={map.width} height={map.height} delayOf={delayOf} />
      {map.nodes.map((n) => (
        <MapNode key={n.id} node={n} selected={n.id === selected} delay={delayOf(n.id)} onPick={() => pick({ runId, nodeId: n.id, live })} />
      ))}
    </div>
  );
}
