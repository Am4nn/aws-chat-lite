"use client";

import { useCallback, useContext, useEffect, useMemo, useState } from "react";
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
import { MapSummary, plural, type TurnSummary } from "./MapSummary";
import { PromptBlock } from "./PromptBlock";
import { StepPick } from "./stepPick";

const STAGGER_S = 0.15;
/** How many turns load at first, and how many more each "Show earlier" adds: each turn opens its own stream. */
const TURNS_PAGE = 10;
const MAX_DELAY_S = 1.5;

type Turn = { runId: string; prompt: string };

/**
 * A thread's Map page: one canvas with a row per turn, newest at the top, like reading the thread backwards. Each row
 * is the message that started the turn with its steps to the right and any helper's lane under them; the prompts link
 * down the left side. One strip above sums the turns shown. It opens on the turn a message's Map link names, else the
 * latest, which the thread's live status keeps current. The latest ten load first; earlier ones load on request, below.
 * A wide row scrolls sideways inside the canvas, so a phone never scrolls the page sideways.
 */
export function ThreadMap({ thread: initial, runId, messages }: { thread: ThreadSummary; runId?: string; messages: Message[] }) {
  const thread = useThreads().byId(initial.threadId) ?? initial;
  const runs = threadRuns(messages, thread.runId);
  const target = runId ?? runs.at(-1)?.runId;
  const [count, setCount] = useState(() => Math.max(TURNS_PAGE, runs.length - runs.findIndex((r) => r.runId === target)));
  const [summaries, setSummaries] = useState<Record<string, TurnSummary>>({});
  const report = useCallback((id: string, summary: TurnSummary) => setSummaries((s) => ({ ...s, [id]: summary })), []);
  useEffect(() => {
    document.getElementById(`run-${target}`)?.scrollIntoView({ block: "start" });
  }, [target]);

  if (!runs.length) return <p className="p-7 text-[13.5px] text-text-3">Nothing has run here yet.</p>;
  const shown = runs.slice(-count).reverse();
  const earlier = runs.length - shown.length;
  return (
    <div className="flex h-full flex-col">
      <MapSummary turns={shown.length} summaries={shown.flatMap((r) => summaries[r.runId] ?? [])} />
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <div className="w-max min-w-full px-4 pt-6 sm:px-[22px]">
          {shown.map((r, i) => (
            <TurnRow
              key={r.runId} turn={r} number={runs.length - i} last={i === shown.length - 1}
              live={isLive(thread.status) && r.runId === thread.runId} onSummary={report}
            />
          ))}
        </div>
        {earlier > 0 && (
          <button
            onClick={() => setCount((n) => n + TURNS_PAGE)}
            className="sticky left-0 mx-4 mb-6 h-8 rounded-[10px] px-3 text-[12.5px] text-text-3 transition-[background-color,color,scale] hover:bg-surface-2 hover:text-text active:scale-[0.97] sm:mx-[22px]"
          >
            Show {Math.min(earlier, TURNS_PAGE)} earlier {earlier === 1 ? "turn" : "turns"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One turn's row: its prompt block, then its map. The line down from the block leads to the turn before it. Replay
 * draws the map in again from the start.
 */
function TurnRow({ turn, number, last, live, onSummary }: {
  turn: Turn; number: number; last: boolean; live: boolean; onSummary: (runId: string, summary: TurnSummary) => void;
}) {
  const { run, unavailable } = useRunStream(turn.runId, live);
  const now = useNow(live && run.status === "running");
  const map = useMemo(() => runMap(run.events, now), [run.events, now]);
  const [replays, setReplays] = useState(0);
  const loaded = run.lastSeq > 0;
  const steps = map.nodes.filter((n) => n.kind === "tool").length;
  const helpers = map.lanes.length - 1;
  const ms = loaded ? (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt ?? run.events[0].at) : 0;
  const { events, costMicros } = run;
  useEffect(() => {
    if (loaded) onSummary(turn.runId, { events, steps, helpers, ms, costMicros });
  }, [loaded, onSummary, turn.runId, events, steps, helpers, ms, costMicros]);
  const stats = loaded ? [steps && plural(steps, "step"), formatElapsed(ms), formatUsd(costMicros)].filter(Boolean).join(" · ") : null;

  return (
    <section id={`run-${turn.runId}`} aria-label={`Turn ${number}`} className="relative flex scroll-mt-6 pb-9 last:pb-6">
      {!last && (
        <span aria-hidden="true" className="absolute bottom-0 left-24 top-12 w-[1.5px] -translate-x-1/2 bg-line-hover">
          <span className="absolute -bottom-[2.5px] left-1/2 size-[5px] -translate-x-1/2 rounded-full bg-line-hover" />
        </span>
      )}
      <PromptBlock prompt={turn.prompt} stats={stats} onReplay={steps ? () => setReplays((n) => n + 1) : undefined} />
      {unavailable
        ? <p className="self-start py-10 pl-6 text-[12.5px] text-text-3">This turn&apos;s steps couldn&apos;t be loaded.</p>
        : loaded
          ? <MapCanvas key={replays} map={map} runId={turn.runId} live={live} />
          : <div className="grid h-24 w-24 place-items-center"><Spinner /></div>}
    </section>
  );
}

/**
 * The edges, cards and helper names. The cards there on the first paint drop in one after another; one that arrives
 * later drops in alone. Remounting (Replay) starts the cascade over.
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
    <div className="relative shrink-0" style={{ width: map.width, height: map.height }}>
      <MapEdges edges={map.edges} width={map.width} height={map.height} delayOf={delayOf} />
      {map.lanes.map((l) => l.at && (
        <span key={l.lane} className="pointer-events-none absolute whitespace-nowrap text-[11.5px] font-semibold leading-[18px] tracking-[.02em] text-text-3" style={{ left: l.at.x + 2, top: l.at.y }}>
          {l.agent} <span className="font-normal">helper</span>
        </span>
      ))}
      {map.nodes.map((n) => (
        <MapNode key={n.id} node={n} selected={n.id === selected} delay={delayOf(n.id)} onPick={() => pick({ runId, nodeId: n.id, live })} />
      ))}
    </div>
  );
}
