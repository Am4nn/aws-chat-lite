"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Budget, RoomView, ThreadSummary } from "../types";
import { RoomAgentsContext } from "./agents";
import { useLiveEvent } from "./LiveProvider";
import { RoomTagsContext } from "./roomTags";
import { applyThreadUpdate, mergeBudget, nextRunDeadline, settleDeadRuns } from "./threads";

type Threads = {
  threads: ThreadSummary[];
  budget: Budget;
  byNumber: (n: number) => ThreadSummary | undefined;
  byId: (threadId: string) => ThreadSummary | undefined;
  /** A thread or budget from an HTTP reply, which can land before (or instead of) its socket event. */
  apply: (thread: ThreadSummary) => void;
  setBudget: (budget: Budget) => void;
};

const ThreadsContext = createContext<Threads | null>(null);

export function useThreads(): Threads {
  const threads = useContext(ThreadsContext);
  if (!threads) throw new Error("useThreads needs a ThreadsProvider");
  return threads;
}

/**
 * The room's threads and agent budget: the server's view, kept current by the socket. Every write bumps a thread's
 * `rev`, so a late or repeated event, or a server render older than an event already applied, never wins. A run that
 * died without closing reads as failed once it passes the server's cutoff, even while the page stays open. It also
 * resolves `#tags` in messages against the room's threads and chats, and hands the room's agents to everything in it.
 */
export function ThreadsProvider({ view, children }: { view: RoomView; children: ReactNode }) {
  const router = useRouter();
  const roomId = view.room.roomId;
  const [stored, setThreads] = useState(view.threads);
  const [budget, setBudgetState] = useState(view.budget);
  const setBudget = useCallback((next: Budget) => setBudgetState((prev) => mergeBudget(prev, next)), []);

  // A refreshed server view merges in, rather than replacing what the socket has already said.
  const [seenView, setSeenView] = useState(view);
  if (view !== seenView) {
    setSeenView(view);
    setThreads((list) => view.threads.reduce(applyThreadUpdate, list));
    setBudget(view.budget);
  }

  const [now, setNow] = useState(() => Date.now());
  const deadline = nextRunDeadline(stored, now);
  useEffect(() => {
    if (deadline === Infinity) return;
    const timer = setTimeout(() => setNow(Date.now()), deadline - Date.now());
    return () => clearTimeout(timer);
  }, [deadline]);
  const threads = useMemo(() => settleDeadRuns(stored, now), [stored, now]);

  useLiveEvent("run.updated", (e) => {
    if (e.roomId !== roomId) return;
    setThreads((list) => applyThreadUpdate(list, e.thread));
    setBudget(e.budget);
  });
  useLiveEvent("thread.updated", (e) => {
    if (e.roomId === roomId) setThreads((list) => applyThreadUpdate(list, e.thread));
  });
  useLiveEvent("budget.updated", (e) => {
    if (e.roomId === roomId) setBudget(e.budget);
  });
  // Events sent while the socket was down are gone; the server's view has everything they would have said.
  useLiveEvent("reconnected", () => router.refresh());

  const value = useMemo<Threads>(() => ({
    threads,
    budget,
    byNumber: (n) => threads.find((t) => t.number === n),
    byId: (id) => threads.find((t) => t.threadId === id),
    apply: (thread) => setThreads((list) => applyThreadUpdate(list, thread)),
    setBudget,
  }), [threads, budget, setBudget]);
  const tags = useMemo(() => ({ roomId, threads, chats: view.chats }), [roomId, threads, view.chats]);
  return (
    <ThreadsContext value={value}>
      <RoomTagsContext value={tags}>
        <RoomAgentsContext value={view.agents}>{children}</RoomAgentsContext>
      </RoomTagsContext>
    </ThreadsContext>
  );
}
