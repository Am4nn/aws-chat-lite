"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { bff } from "./bff";
import { LiveSocket, type ClientEvent } from "./live";

const LiveContext = createContext<LiveSocket | null>(null);

export function useLive(): LiveSocket {
  const live = useContext(LiveContext);
  if (!live) throw new Error("useLive needs a LiveProvider");
  return live;
}

/** Subscribes for the component's lifetime; the latest handler always runs, so callers needn't memoise it. */
export function useLiveEvent<T extends ClientEvent["type"]>(type: T, handler: (e: ClientEvent & { type: T }) => void) {
  const live = useLive();
  const latest = useRef(handler);
  useEffect(() => { latest.current = handler; });
  useEffect(() => live.on(type, (e) => latest.current(e)), [live, type]);
}

export function useLiveStatus() {
  const live = useLive();
  return useSyncExternalStore((fn) => live.onStatus(fn), () => live.status, () => "connecting" as const);
}

/** One socket per tab, shared by everything in the room. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [live] = useState(() => new LiveSocket({ getTicket: () => bff("/bff/api/live/ticket", { body: {} }) }));
  useEffect(() => {
    live.start();
    // Outside production the socket is reachable from the console, so a test can drop it and watch the reconnect.
    if (process.env.NODE_ENV !== "production") Object.assign(window, { __live: live });
    return () => live.stop();
  }, [live]);
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}
