"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Budget, RoomView, ThreadSummary } from "../types";
import { useLiveEvent } from "./LiveProvider";
import { applyThreadUpdate } from "./threads";

type Threads = {
  threads: ThreadSummary[];
  budget: Budget;
  byNumber: (n: number) => ThreadSummary | undefined;
  byId: (threadId: string) => ThreadSummary | undefined;
};

const ThreadsContext = createContext<Threads | null>(null);

export function useThreads(): Threads {
  const threads = useContext(ThreadsContext);
  if (!threads) throw new Error("useThreads needs a ThreadsProvider");
  return threads;
}

/**
 * The room's threads and agent budget: the server's view, kept current by the socket. Every write bumps a thread's
 * `rev`, so a late or repeated event, or a server render older than an event already applied, never wins.
 */
export function ThreadsProvider({ view, children }: { view: RoomView; children: ReactNode }) {
  const router = useRouter();
  const roomId = view.room.roomId;
  const [threads, setThreads] = useState(view.threads);
  const [budget, setBudget] = useState(view.budget);

  // A refreshed server view merges in, rather than replacing what the socket has already said.
  const [seenView, setSeenView] = useState(view);
  if (view !== seenView) {
    setSeenView(view);
    setThreads((list) => view.threads.reduce(applyThreadUpdate, list));
    setBudget(view.budget);
  }

  useLiveEvent("run.updated", (e) => {
    if (e.roomId !== roomId) return;
    setThreads((list) => applyThreadUpdate(list, e.thread));
    setBudget(e.budget);
  });
  useLiveEvent("thread.updated", (e) => {
    if (e.roomId === roomId) setThreads((list) => applyThreadUpdate(list, e.thread));
  });
  // Events sent while the socket was down are gone; the server's view has everything they would have said.
  useLiveEvent("reconnected", () => router.refresh());

  const value = useMemo<Threads>(() => ({
    threads,
    budget,
    byNumber: (n) => threads.find((t) => t.number === n),
    byId: (id) => threads.find((t) => t.threadId === id),
  }), [threads, budget]);
  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>;
}
