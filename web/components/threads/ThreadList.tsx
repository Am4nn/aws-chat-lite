"use client";

import { useContext, useRef } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Bot, Plus } from "lucide-react";
import { agentLabel, RoomAgentsContext } from "@/lib/client/agents";
import { liveCount, sidebarThreads, stateText, threadMeta } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { useNow } from "@/lib/client/useNow";
import { spring } from "@/lib/motion";
import type { ThreadSummary } from "@/lib/types";
import { ThreadStatusIcon } from "./ThreadStatusIcon";

const IDLE_TICK_MS = 60_000;

/**
 * The sidebar's agent threads, newest activity first, each with its live state. Its selection highlight is the same
 * element as the chat list's, so it glides across both lists. A thread names its agent unless that is @agent, which
 * most threads are answered by.
 */
export function ThreadList({ roomId, activeThreadId, canCreate, timeZone }: {
  roomId: string; activeThreadId?: string; canCreate: boolean; timeZone: string;
}) {
  const { threads } = useThreads();
  const live = liveCount(threads);
  // Running threads count their seconds; otherwise the clock only moves day labels and the idle cut-off along.
  const now = useNow(true, live ? 1000 : IDLE_TICK_MS);
  const shown = sidebarThreads(threads, now);
  // Threads that appear after the page loaded (just started) get a one-time entrance.
  const initial = useRef(new Set(threads.map((t) => t.threadId)));
  const agents = useContext(RoomAgentsContext);

  return (
    <section>
      <div className="flex h-[30px] items-center gap-2 pb-1.5 pl-2.5">
        <h2 className="text-[11.5px] font-semibold text-text-3">Agent threads</h2>
        {threads.length > 0 && (
          <span className={`ml-auto font-mono text-[11px] tabular-nums transition-colors duration-300 ${live ? "text-lime" : "text-text-3"}`}>{live} live</span>
        )}
        {canCreate && (
          <Link
            href={`/r/${roomId}/t/new`}
            aria-label="New thread"
            title="New thread"
            className={`${threads.length ? "" : "ml-auto"} grid size-6 place-items-center rounded-md text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90`}
          >
            <Plus aria-hidden="true" size={14} />
          </Link>
        )}
      </div>
      {shown.length === 0
        ? (
          <div className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[12.5px] leading-snug text-text-3">
            <Bot aria-hidden="true" size={15} className="shrink-0" />
            Agent work will appear here as threads.
          </div>
        )
        : (
          <ul className="flex flex-col gap-1">
            {shown.map((t) => (
              <ThreadRow
                key={t.threadId} thread={t} href={`/r/${roomId}/t/${t.number}`} active={t.threadId === activeThreadId}
                fresh={!initial.current.has(t.threadId)} meta={threadMeta(t, now, timeZone)} agent={agentLabel(t.agentId, agents)}
              />
            ))}
          </ul>
        )}
    </section>
  );
}

function ThreadRow({ thread: t, href, active, fresh, meta, agent }: {
  thread: ThreadSummary; href: string; active: boolean; fresh: boolean; meta: ReturnType<typeof threadMeta>; agent: string;
}) {
  return (
    <li className={fresh ? "animate-[row-in_.45s_cubic-bezier(.2,.9,.2,1)_both] motion-reduce:animate-none" : ""}>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`relative isolate flex h-10 items-center gap-2.5 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors ${
          active ? "text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"
        }`}
      >
        {active && (
          <motion.span layoutId="nav-highlight" transition={spring.glide} className="absolute inset-0 -z-10 rounded-[10px] bg-surface-3 shadow-ring" />
        )}
        <span className="grid size-4 shrink-0 place-items-center"><ThreadStatusIcon status={t.status} /></span>
        <span className="truncate">{t.name}</span>
        {agent !== "@agent" && <span className="-ml-1 shrink-0 font-mono text-[11.5px] font-normal text-text-3">{agent}</span>}
        <span
          suppressHydrationWarning
          className={`ml-auto shrink-0 font-mono text-[11px] font-normal tabular-nums ${meta.tone === "live" ? "text-lime" : meta.tone === "waiting" ? "text-amber" : "text-text-3"}`}
        >
          {meta.text}
        </span>
        {t.status !== "idle" && <span className="sr-only">, {stateText(t.status)}</span>}
      </Link>
    </li>
  );
}
