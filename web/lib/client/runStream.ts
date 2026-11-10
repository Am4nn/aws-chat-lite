import type { RunEvent } from "../types";
import { backoffMs } from "./live";
import { createSseParser } from "./sse";

type Options = {
  getUrl: () => Promise<string>;
  onEvent: (e: RunEvent) => void;
  // Called once with the status of a 4xx response, after which the stream stays closed; retrying would never succeed.
  onError?: (status: number) => void;
  fetchImpl?: typeof fetch;
  random?: () => number;
};

// The server ends each stream after a few minutes, so a finished body without run.finished is a normal resume, not an error.
export function openRunStream({ getUrl, onEvent, onError, fetchImpl = fetch, random = Math.random }: Options) {
  let closed = false;
  let finished = false;
  let lastSeq = 0;
  let attempt = 0;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  async function connect() {
    controller = new AbortController();
    try {
      const url = await getUrl();
      if (closed) return;
      const headers: Record<string, string> = lastSeq ? { "Last-Event-ID": String(lastSeq) } : {};
      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (res.status >= 400 && res.status < 500) {
        finished = true;
        onError?.(res.status);
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(value)) {
          if (closed) return;
          const event = JSON.parse(frame.data) as RunEvent;
          // A throwing handler leaves lastSeq behind so the event is redelivered on resume.
          onEvent(event);
          attempt = 0;
          lastSeq = Math.max(lastSeq, event.seq);
          if (event.type === "run.finished") {
            finished = true;
            controller.abort();
            return;
          }
        }
      }
    } catch {
      // Falls through to the reconnect below.
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
