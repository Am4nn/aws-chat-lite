import type { Message } from "../chat/model.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { summaryLine } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus } from "../threads/types.js";
import { answerOf } from "./context.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";

/** Best effort: the answer is stored, and a client that misses it gets it with the thread's history. */
async function announce(answer: Message) {
  try {
    await broadcastToRoom(answer.roomId, { type: "message.new", message: answer });
  } catch (e) {
    console.error("answer broadcast failed", answer.roomId, e);
  }
}

/**
 * Ends a run: posts the answer (all the text it streamed), then writes `run.finished`, then tells the room. The event
 * comes after the close because a close can come back "unread", and then the run carries on; a stream that saw
 * `run.finished` would already have stopped reading. A close that finds the run already closed (a retried step)
 * reports the ending that is stored, whatever this attempt meant to write.
 */
export async function finishRun(
  run: Run, end: { status: RunEndStatus; reason?: string }, opts: { seenSeq: number; force: boolean },
): Promise<"closed" | "unread" | "already"> {
  const runs = runsRepo();
  const events = await runs.allEvents(run.runId);
  const { text, final } = answerOf(events);
  const { result, answer } = await runs.closeRun(run, { ...end, text, summary: summaryLine(final) || end.reason || "", ...opts });
  if (result === "unread") return result;

  let last = events.at(-1);
  if (last?.type !== "run.finished") {
    const closed = result === "already" ? (await runs.getRun(run.runId))! : { ...run, ...end, endedAt: new Date().toISOString() };
    last = await (await runs.eventWriter(run.runId)).append({
      type: "run.finished", status: closed.status as RunEndStatus, reason: closed.reason,
      ms: Date.parse(closed.endedAt!) - Date.parse(run.startedAt), steps: closed.steps, costMicros: closed.costMicros,
    });
  }
  if (answer) await announce(answer);
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  if (thread) await notifyRun(run.roomId, thread, last.seq);
  return result;
}
