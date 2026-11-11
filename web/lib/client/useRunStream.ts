"use client";

import { useEffect, useRef, useState } from "react";
import { bff } from "./bff";
import { applyRunEvent, emptyRun, type RunView } from "./run";
import { openRunStream } from "./runStream";

/**
 * A run's events, read over its resumable stream while `runId` is set. A live run is published at most once per
 * animation frame, however fast its events come, so a burst of text renders (and animates) as one batch. Any other
 * run is a replay, published once its last event arrives so its rows appear together. `unavailable`: the server
 * refused the stream (the run is gone, or I left the room) or its events can't be shown, so it will never fill in.
 */
export function useRunStream(runId: string | undefined, live: boolean): { run: RunView; unavailable: boolean } {
  const [view, setView] = useState(emptyRun);
  const [unavailable, setUnavailable] = useState(false);
  const liveNow = useRef(live);
  useEffect(() => { liveNow.current = live; });

  useEffect(() => {
    if (!runId) return;
    let current = emptyRun();
    let frame = 0;
    const flush = () => {
      frame = 0;
      setView(current);
    };
    const stream = openRunStream({
      // Tickets are single use, so every reconnect asks for a fresh URL.
      getUrl: async () => (await bff<{ url: string }>(`/bff/api/runs/${runId}/stream-ticket`, { body: {} })).url,
      onEvent(e) {
        current = applyRunEvent(current, e);
        if (e.type === "run.finished") {
          cancelAnimationFrame(frame);
          flush();
        } else if (liveNow.current && !frame) {
          frame = requestAnimationFrame(flush);
        }
      },
      onError: () => setUnavailable(true),
    });
    // Outside production a test can cut the stream from the console and watch it resume.
    if (process.env.NODE_ENV !== "production") Object.assign(window, { __runStream: { drop: () => stream.drop() } });
    return () => {
      stream.close();
      cancelAnimationFrame(frame);
    };
  }, [runId]);

  return { run: view, unavailable };
}
