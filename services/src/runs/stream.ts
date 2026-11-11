import { NotFound } from "../lib/errors.js";
import { requireMember } from "../chat/membership.js";
import type { RunEvent } from "../threads/types.js";
import { runsRepo } from "./repo.js";
import { consumeStreamTicket } from "./stream-tickets.js";

const POLL_MS = 250;
/** Proxies and browsers drop a connection that has been silent too long; a comment line keeps it open. */
const KEEPALIVE_MS = 15_000;
const MEMBER_CHECK_MS = 30_000;
/** Under the stream function's 15-minute timeout, so the stream ends cleanly and the client resumes. */
const MAX_STREAM_MS = 14 * 60_000;

export const STREAM_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };

/** The run id in a stream path, `/runs/<runId>/stream`. */
export const runIdFromPath = (path: string) => /^\/runs\/([A-Za-z0-9-]+)\/stream$/.exec(path)?.[1];

interface StreamSink { status(code: number): void; write(chunk: string): void; end(): void }

export interface StreamDeps {
  consume: typeof consumeStreamTicket;
  events(runId: string, afterSeq: number): Promise<RunEvent[]>;
  isMember(roomId: string, userId: string): Promise<boolean>;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

function liveDeps(): StreamDeps {
  const runs = runsRepo();
  return {
    consume: consumeStreamTicket,
    events: (runId, afterSeq) => runs.events(runId, afterSeq),
    isMember: (roomId, userId) => requireMember(roomId, userId).then(() => true, (e) => {
      if (e instanceof NotFound) return false;
      throw e;
    }),
    nowMs: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** The SSE frame for one run event. Its id is the event's seq, which a reconnecting client sends back as Last-Event-ID. */
const frame = (e: RunEvent) => `id: ${e.seq}\nevent: run\ndata: ${JSON.stringify(e)}\n\n`;

/** The seq the client already has: a whole number, else 0 (start from the beginning). */
const resumeAfter = (lastEventId: string | undefined) => (/^\d+$/.test(lastEventId ?? "") ? Number(lastEventId) : 0);

/**
 * Streams a run's event log as server-sent events, resuming after Last-Event-ID. The log is append-only and every
 * event keeps its seq, so sending only `seq > Last-Event-ID` gives a reconnecting client each event exactly once.
 * The one-time ticket is the auth (a browser can't put a JWT on this request), and membership is checked again
 * every 30 s so a removed member's open stream ends.
 */
export async function streamRun(
  req: { runId: string; ticket: string; lastEventId?: string; signal?: AbortSignal }, sink: StreamSink, deps: StreamDeps = liveDeps(),
): Promise<void> {
  const viewer = await deps.consume(req.ticket, req.runId);
  if (!viewer) {
    sink.status(401);
    sink.end();
    return;
  }
  sink.status(200);
  const startedAt = deps.nowMs();
  let cursor = resumeAfter(req.lastEventId);
  let lastWriteAt = startedAt;
  let memberCheckedAt = startedAt;
  while (!req.signal?.aborted) {
    const events = await deps.events(req.runId, cursor);
    for (const e of events) {
      if (req.signal?.aborted) break;
      sink.write(frame(e));
      cursor = e.seq;
      if (e.type === "run.finished") return sink.end();
    }
    const now = deps.nowMs();
    if (events.length) lastWriteAt = now;
    if (now - startedAt >= MAX_STREAM_MS) break;
    if (now - memberCheckedAt >= MEMBER_CHECK_MS) {
      if (!await deps.isMember(viewer.roomId, viewer.userId)) break;
      memberCheckedAt = now;
    }
    if (now - lastWriteAt >= KEEPALIVE_MS) {
      sink.write(": ka\n\n");
      lastWriteAt = now;
    }
    // A page of events may have more behind it, so only a caught-up stream waits.
    if (!events.length) await deps.sleep(POLL_MS);
  }
  sink.end();
}
