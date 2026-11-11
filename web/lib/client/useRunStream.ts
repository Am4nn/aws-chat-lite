import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { bff } from "./bff";
import { applyRunEvent, emptyRun, type RunView } from "./run";
import { openRunStream } from "./runStream";

type Snapshot = { run: RunView; unavailable: boolean };
type Shared = { snapshot: Snapshot; readers: Map<() => void, { current: boolean }>; close: () => void };

const NONE: Snapshot = { run: emptyRun(), unavailable: false };
const shared = new Map<string, Shared>();

function open(runId: string): Shared {
  const s: Shared = { snapshot: NONE, readers: new Map(), close: () => {} };
  let current = emptyRun();
  let frame = 0;
  const publish = (next: Partial<Snapshot>) => {
    s.snapshot = { ...s.snapshot, ...next };
    s.readers.forEach((_, notify) => notify());
  };
  const flush = () => {
    frame = 0;
    publish({ run: current });
  };
  const stream = openRunStream({
    // Tickets are single use, so every reconnect asks for a fresh URL.
    getUrl: async () => (await bff<{ url: string }>(`/bff/api/runs/${runId}/stream-ticket`, { body: {} })).url,
    onEvent(e) {
      current = applyRunEvent(current, e);
      const live = [...s.readers.values()].some((r) => r.current);
      if (e.type === "run.finished") {
        cancelAnimationFrame(frame);
        flush();
      } else if (live && !frame) {
        frame = requestAnimationFrame(flush);
      }
    },
    onError: () => publish({ unavailable: true }),
  });
  // Outside production a test can cut the stream from the console and watch it resume.
  if (process.env.NODE_ENV !== "production") Object.assign(window, { __runStream: { drop: () => stream.drop() } });
  s.close = () => {
    stream.close();
    cancelAnimationFrame(frame);
  };
  return s;
}

/**
 * A run's events, read over its resumable stream while `runId` is set. Everything showing the same run (its block in
 * the thread, the room panel's sources) shares one stream, opened by the first reader and closed after the last. A
 * live run is published at most once per animation frame, however fast its events come, so a burst of text renders
 * (and animates) as one batch. Any other run is a replay, published once its last event arrives so its rows appear
 * together. `unavailable`: the server refused the stream (the run is gone, or I left the room) or its events can't be
 * shown, so it will never fill in.
 */
export function useRunStream(runId: string | undefined, live: boolean): Snapshot {
  const liveNow = useRef(live);
  useEffect(() => { liveNow.current = live; });

  const subscribe = useCallback((notify: () => void) => {
    if (!runId) return () => {};
    let s = shared.get(runId);
    if (!s) shared.set(runId, (s = open(runId)));
    s.readers.set(notify, liveNow);
    return () => {
      s.readers.delete(notify);
      if (s.readers.size) return;
      s.close();
      shared.delete(runId);
    };
  }, [runId]);
  return useSyncExternalStore(subscribe, () => (runId && shared.get(runId)?.snapshot) || NONE, () => NONE);
}
