import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus } from "../threads/types.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";

/**
 * Ends a run: posts the answer (all the text it streamed), then writes `run.finished` and tells the room. The event
 * comes after the close because a close can come back "unread", and then the run carries on; a stream that saw
 * `run.finished` would already have stopped reading.
 */
export async function finishRun(
  run: Run, end: { status: RunEndStatus; reason?: string }, opts: { seenSeq: number; force: boolean },
): Promise<"closed" | "unread" | "already"> {
  const runs = runsRepo();
  const events = await runs.allEvents(run.runId);
  const text = events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
  const result = await runs.closeRun(run, { ...end, text, ...opts });
  if (result === "unread") return result;

  // A retried close finds the run already closed, and maybe its event written too.
  let last = events.at(-1);
  if (last?.type !== "run.finished") {
    const writer = await runs.eventWriter(run.runId);
    last = await writer.append({
      type: "run.finished", ...end, ms: Date.now() - Date.parse(run.startedAt), steps: run.steps, costMicros: run.costMicros,
    });
  }
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  if (thread) await notifyRun(run.roomId, thread, last.seq);
  return result;
}
