import { NotFound } from "../lib/errors.js";
import { sleep } from "../lib/sleep.js";
import { requireMember } from "../chat/membership.js";
import type { RunEvent } from "../threads/types.js";
import { runsRepo, type Run } from "./repo.js";
import { consumeStreamTicket } from "./stream-tickets.js";

const POLL_MS = 250;
/** Proxies and browsers drop a connection that has been silent too long; a comment line keeps it open. */
const KEEPALIVE_MS = 15_000;
const CHECK_MS = 30_000;
/** Under the stream function's 15-minute timeout, so the stream ends cleanly and the client resumes. */
const MAX_STREAM_MS = 14 * 60_000;

/** The headers for a response with this status: an event stream, or a short JSON error. */
export const headersFor = (status: number): Record<string, string> =>
  status === 200 ? { "content-type": "text/event-stream", "cache-control": "no-cache" } : { "content-type": "application/json" };

/** The run id in a stream path, `/runs/<runId>/stream`. */
export const runIdFromPath = (path: string) => /^\/runs\/([A-Za-z0-9-]+)\/stream$/.exec(path)?.[1];

interface StreamSink { status(code: number): void; write(chunk: string): void; end(): void }

/**
 * An error response with a body: a Function URL sends its status prelude with the first bytes written, so a
 * response that ended empty could reach the client without its status.
 */
export function refuse(sink: StreamSink, status: number, error: string) {
  sink.status(status);
  sink.write(JSON.stringify({ error }));
  sink.end();
}

export interface StreamDeps {
  consume: typeof consumeStreamTicket;
  events(runId: string, afterSeq: number): Promise<RunEvent[]>;
  getRun(runId: string): Promise<Pick<Run, "status" | "startedAt" | "deadAt" | "endedAt"> | undefined>;
  isMember(roomId: string, userId: string): Promise<boolean>;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

function liveDeps(): StreamDeps {
  const runs = runsRepo();
  return {
    consume: consumeStreamTicket,
    events: (runId, afterSeq) => runs.events(runId, afterSeq),
    getRun: runs.getRun,
    isMember: (roomId, userId) => requireMember(roomId, userId).then(() => true, (e) => {
      if (e instanceof NotFound) return false;
      throw e;
    }),
    nowMs: Date.now,
    sleep,
  };
}

/** The SSE frame for one run event. Its id is the event's seq, which a reconnecting client sends back as Last-Event-ID. */
const frame = (e: RunEvent) => `id: ${e.seq}\nevent: run\ndata: ${JSON.stringify(e)}\n\n`;

/** The seq the client already has: a whole number, else 0 (start from the beginning). */
const resumeAfter = (lastEventId: string | undefined) => (/^\d+$/.test(lastEventId ?? "") ? Number(lastEventId) : 0);

/**
 * True once the run can write no more events, though its log may lack `run.finished`: past its `deadAt` while still
 * marked running, or closed more than 30 s ago (the closer writes `run.finished` right after the close).
 */
async function runOver(deps: StreamDeps, runId: string, nowMs: number): Promise<boolean> {
  const run = await deps.getRun(runId);
  if (!run) return true;
  if (run.status === "running") return nowMs > Date.parse(run.deadAt);
  return nowMs - Date.parse(run.endedAt ?? run.startedAt) >= CHECK_MS;
}

/**
 * Streams a run's event log as server-sent events, resuming after Last-Event-ID. The log is append-only and every
 * event keeps its seq, so sending only `seq > Last-Event-ID` gives a reconnecting client each event exactly once.
 * The one-time ticket is the auth (a browser can't put a JWT on this request).
 *
 * Membership is checked at connect and every 30 s after, so a removed member's open stream ends. A run that died
 * without `run.finished` would otherwise be streamed until the time limit, and resumed forever: its stream ends once
 * nothing is left to send, and a reconnect then gets 410, which tells the client to stop.
 */
export async function streamRun(
  req: { runId: string; ticket: string; lastEventId?: string; signal?: AbortSignal }, sink: StreamSink, deps: StreamDeps = liveDeps(),
): Promise<void> {
  const viewer = await deps.consume(req.ticket, req.runId);
  if (!viewer) return refuse(sink, 401, "This stream link has expired or was already used.");
  if (!await deps.isMember(viewer.roomId, viewer.userId)) return refuse(sink, 404, "Run not found.");
  let cursor = resumeAfter(req.lastEventId);
  let events = await deps.events(req.runId, cursor);
  const startedAt = deps.nowMs();
  if (!events.length && await runOver(deps, req.runId, startedAt)) return refuse(sink, 410, "This run has ended.");

  sink.status(200);
  let lastWriteAt = startedAt;
  let checkedAt = startedAt;
  for (;;) {
    for (const e of events) {
      if (req.signal?.aborted) break;
      cursor = e.seq;
      // A native turn exists to be replayed to its model, and can hold content viewers never see, such as thinking.
      if (e.type === "model.turn") continue;
      sink.write(frame(e));
      if (e.type === "run.finished") return sink.end();
    }
    const now = deps.nowMs();
    if (events.length) lastWriteAt = now;
    if (now - startedAt >= MAX_STREAM_MS) break;
    if (now - checkedAt >= CHECK_MS) {
      if (!await deps.isMember(viewer.roomId, viewer.userId)) break;
      if (!events.length && await runOver(deps, req.runId, now)) break;
      checkedAt = now;
    }
    if (now - lastWriteAt >= KEEPALIVE_MS) {
      sink.write(": ka\n\n");
      lastWriteAt = now;
    }
    // A page of events may have more behind it, so only a caught-up stream waits.
    if (!events.length) await deps.sleep(POLL_MS);
    if (req.signal?.aborted) break;
    events = await deps.events(req.runId, cursor);
  }
  sink.end();
}
