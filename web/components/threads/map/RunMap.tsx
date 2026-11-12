"use client";

import { useContext, useEffect, useMemo, useState } from "react";
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
import { StepPick } from "./stepPick";
import { TimeShare } from "./TimeShare";

const STAGGER_S = 0.15;
/** How many turns load at first, and how many more each "Show earlier" adds: each turn opens its own stream. */
const TURNS_PAGE = 10;
const MAX_DELAY_S = 1.5;

/**
 * A thread's Map page: every turn at once, oldest first, each headed by the message that started it and drawn as its
 * own map. It opens on the turn a message's Map link names, else the latest, which the thread's live status keeps
 * current. The latest ten load first; earlier ones load on request.
 */
export function ThreadMap({ thread: initial, runId, messages }: { thread: ThreadSummary; runId?: string; messages: Message[] }) {
  const thread = useThreads().byId(initial.threadId) ?? initial;
  const runs = threadRuns(messages, thread.runId);
  const target = runId ?? runs.at(-1)?.runId;
  const [count, setCount] = useState(() => Math.max(TURNS_PAGE, runs.length - runs.findIndex((r) => r.runId === target)));
  useEffect(() => {
    document.getElementById(`run-${target}`)?.scrollIntoView({ block: "start" });
  }, [target]);

  if (!runs.length) return <p className="p-7 text-[13.5px] text-text-3">Nothing has run here yet.</p>;
  const shown = runs.slice(-count);
  const earlier = runs.length - shown.length;
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      {earlier > 0 && (
        <button
          onClick={() => setCount((n) => n + TURNS_PAGE)}
          className="mx-4 mt-3 h-8 rounded-[10px] px-3 text-[12.5px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text sm:mx-[22px]"
        >
          Show {Math.min(earlier, TURNS_PAGE)} earlier {earlier === 1 ? "turn" : "turns"}
        </button>
      )}
      {shown.map((r, i) => (
        <section key={r.runId} id={`run-${r.runId}`} aria-label={`Turn ${runs.length - shown.length + i + 1}`} className="scroll-mt-2 border-b border-line">
          <h3 className="truncate px-4 pt-4 text-[13.5px] text-text-2 sm:px-[22px]">{r.prompt || "This turn"}</h3>
          <RunMap runId={r.runId} live={isLive(thread.status) && r.runId === thread.runId} />
        </section>
      ))}
    </div>
  );
}

/**
 * One run as a map: a bar with its step count, helpers, time and cost and where that time went, then a lane per agent
 * with a card per step. A wide map scrolls sideways inside its own box, so a phone never scrolls the page sideways,
 * and the lane labels stay in view. Replay draws it in again from the start.
 */
export function RunMap({ runId, live }: { runId: string; live: boolean }) {
  const { run, unavailable } = useRunStream(runId, live);
  const running = live && run.status === "running";
  const now = useNow(running);
  const map = useMemo(() => runMap(run.events, now), [run.events, now]);
  const [replays, setReplays] = useState(0);

  if (unavailable) return <p className="p-7 text-[13.5px] text-text-3">This run&apos;s steps couldn&apos;t be loaded.</p>;
  if (!run.lastSeq) return <div className="grid h-24 place-items-center"><Spinner /></div>;

  const steps = map.nodes.filter((n) => n.kind === "tool").length;
  const helpers = map.lanes.length - 1;
  const elapsed = (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt ?? run.events[0].at);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-[22px]">
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
      <div className="relative overflow-x-auto overscroll-x-contain">
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
