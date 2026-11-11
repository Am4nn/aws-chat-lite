import type { RunEvent } from "../types";
import { backoffMs } from "./live";
import { createSseParser } from "./sse";

// An event that fails to apply comes again on resume, so one that always fails would otherwise reconnect forever.
const MAX_APPLY_FAILURES = 3;

type Options = {
  getUrl: () => Promise<string>;
  onEvent: (e: RunEvent) => void;
  /**
   * Called once when the stream gives up for good: the server refused it (a 4xx other than 408 and 429, on the stream
   * or on asking for its URL), so retrying would never succeed, or an event kept failing to apply.
   */
  onError?: () => void;
  fetchImpl?: typeof fetch;
  random?: () => number;
};

const refused = (e: unknown) => {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
};

// The server ends each stream after a few minutes, so a finished body without run.finished is a normal resume, not an error.
export function openRunStream({ getUrl, onEvent, onError, fetchImpl = fetch, random = Math.random }: Options) {
  let closed = false;
  let finished = false;
  let lastSeq = 0;
  let attempt = 0;
  let applyFailures = 0;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function giveUp() {
    finished = true;
    controller?.abort();
    onError?.();
  }

  async function connect() {
    controller = new AbortController();
    try {
      const url = await getUrl();
      if (closed) return;
      const headers: Record<string, string> = lastSeq ? { "Last-Event-ID": String(lastSeq) } : {};
      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (!res.ok || !res.body) throw Object.assign(new Error(`stream ${res.status}`), { status: res.status });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(value)) {
          if (closed) return;
          let event: RunEvent;
          try {
            event = JSON.parse(frame.data) as RunEvent;
            // A throw leaves lastSeq behind, so the event is redelivered on resume.
            onEvent(event);
          } catch (e) {
            if (++applyFailures < MAX_APPLY_FAILURES) throw e;
            console.error(e);
            return giveUp();
          }
          applyFailures = 0;
          attempt = 0;
          lastSeq = Math.max(lastSeq, event.seq);
          if (event.type === "run.finished") {
            finished = true;
            controller.abort();
            return;
          }
        }
      }
    } catch (e) {
      if (refused(e) && !closed) return giveUp();
    }
    if (closed || finished) return;
    retryTimer = setTimeout(connect, backoffMs(attempt++, random));
  }

  void connect();

  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      controller?.abort();
    },
    drop() {
      controller?.abort();
    },
  };
}
