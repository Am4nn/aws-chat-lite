import { SKIP_NOTE } from "../approvals/model.js";
import type { Message } from "../chat/model.js";
import { bestEffort } from "../lib/best-effort.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { enqueuePush } from "../push/enqueue.js";
import { summaryLine } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus, RunEvent } from "../threads/types.js";
import { closeSandbox } from "../workspace/session.js";
import { answerOf, stepEvent } from "./context.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";

/** Best effort: the answer is stored, and a client that misses it gets it with the thread's history. */
const answerPosted = (answer: Message) =>
  bestEffort("answer broadcast", () => broadcastToRoom(answer.roomId, { type: "message.new", message: answer }));

/** Model turns count from 1, so no `text.reset` of a retried turn can void a note tagged 0. */
const NOTE_TURN = 0;

/** A note for each call skipped because no one approved it in time, that the answer doesn't carry yet. */
function skipNotes(events: RunEvent[]): string[] {
  const texts = new Set(events.flatMap((e) => (e.type === "text" ? [e.text] : [])));
  return events.flatMap((e) => {
    if (e.type !== "approval.settled" || e.decision !== "expired") return [];
    const asked = stepEvent(events, "approval.requested", e.step);
    const note = asked ? SKIP_NOTE(asked.title) : "";
    return note && !texts.has(note) ? [note] : [];
  });
}

/**
 * Ends a run: posts the answer (all the text it streamed), then writes `run.finished`, then tells the room. The event
 * comes after the close because a close can come back "unread", and then the run carries on; a stream that saw
 * `run.finished` would already have stopped reading. A close that finds the run already closed (a retried step)
 * reports the ending that is stored, whatever this attempt meant to write, and announces the answer only if the
 * attempt before it stopped short of `run.finished`. The card shows the answer's first line for a finished run, and
 * otherwise why the run ended. Every ending also closes the run's sandbox, and the answer ends by naming any call that
 * was skipped for want of an approval. Those notes are logged only once the close has ended the run: a close that comes
 * back "unread" carries on, and its next turn's text would follow a note logged before it.
 */
export async function finishRun(
  run: Run, end: { status: RunEndStatus; reason?: string }, opts: { seenSeq: number; force: boolean },
): Promise<"closed" | "unread" | "already"> {
  const runs = runsRepo();
  const events = await runs.allEvents(run.runId);
  const notes = skipNotes(events);
  const noted = notes.join("");
  const { text, final, images } = answerOf(events);
  const summary = end.status === "done" ? summaryLine(final + noted) : end.reason ?? "";
  const { result, answer, endedAt } = await runs.closeRun(run, { ...end, text: text + noted, images, summary, ...opts });
  if (result === "unread") return result;
  if (notes.length) {
    const writer = await runs.eventWriter(run.runId);
    for (const text of notes) events.push(await writer.append({ type: "text", text, turn: NOTE_TURN }));
  }
  // Before `run.finished`, so a run that reads as ended never still holds a sandbox session.
  await closeSandbox(run.runId);

  let last = events.at(-1);
  const finished = last?.type === "run.finished";
  if (last?.type !== "run.finished") {
    const closed = result === "already" ? (await runs.getRun(run.runId))! : { ...run, ...end, endedAt };
    last = await (await runs.eventWriter(run.runId)).append({
      type: "run.finished", status: closed.status as RunEndStatus, reason: closed.reason,
      ms: Date.parse(closed.endedAt!) - Date.parse(run.startedAt), steps: closed.steps, costMicros: closed.costMicros,
    });
  }
  if (answer && !finished) await answerPosted(answer);
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  // A run replaced as dead closes without its thread, which now shows the newer run.
  if (thread?.runId === run.runId) await notifyRun(run.roomId, thread, last.seq);
  if (result === "closed") await tellStarter(run, end, summary);
  return result;
}

/**
 * The starter hears how their run ended, once: only the attempt whose close ended it tells them. A run its own starter
 * stopped needs no news.
 */
async function tellStarter(run: Run, end: { status: RunEndStatus; reason?: string }, summary: string) {
  if (!run.startedById) return;
  const stopper = end.status === "stopped" ? (await runsRepo().getRun(run.runId))?.stopRequestedBy : undefined;
  if (stopper === run.startedBy) return;
  await enqueuePush({
    kind: "run", roomId: run.roomId, threadId: run.threadId, number: run.number, status: end.status,
    ...(end.status === "done" ? { summary } : { reason: end.reason }), ...(stopper && { stoppedBy: stopper }), userIds: [run.startedById],
  });
}
