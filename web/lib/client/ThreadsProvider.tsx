"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Budget, RoomView, ThreadSummary } from "../types";
import { useLiveEvent } from "./LiveProvider";
import { RoomTagsContext } from "./roomTags";
import { applyThreadUpdate } from "./threads";

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
 * `rev`, so a late or repeated event, or a server render older than an event already applied, never wins. It also
 * resolves `#tags` in messages against the room's threads and chats.
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
    apply: (thread) => setThreads((list) => applyThreadUpdate(list, thread)),
    setBudget,
  }), [threads, budget]);
  const tags = useMemo(() => ({ roomId, threads, chats: view.chats }), [roomId, threads, view.chats]);
  return (
    <ThreadsContext value={value}>
      <RoomTagsContext value={tags}>{children}</RoomTagsContext>
    </ThreadsContext>
  );
}
