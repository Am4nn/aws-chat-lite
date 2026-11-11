import { SKIP_NOTE } from "../approvals/model.js";
import type { Message } from "../chat/model.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { summaryLine } from "../threads/model.js";
import { threadsRepo } from "../threads/repo.js";
import type { RunEndStatus, RunEvent } from "../threads/types.js";
import { closeSandbox } from "../workspace/session.js";
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

/** Model turns count from 1, so no `text.reset` of a retried turn can void a note tagged 0. */
const NOTE_TURN = 0;

/** A note for each call skipped because no one approved it in time, that the answer doesn't carry yet. */
function skipNotes(events: RunEvent[]): string[] {
  const texts = new Set(events.flatMap((e) => (e.type === "text" ? [e.text] : [])));
  return events.flatMap((e) => {
    if (e.type !== "approval.settled" || e.decision !== "expired") return [];
    const asked = events.find((r) => r.type === "approval.requested" && r.step === e.step);
    const note = asked?.type === "approval.requested" ? SKIP_NOTE(asked.title) : "";
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
  const { text, final } = answerOf(events);
  const summary = end.status === "done" ? summaryLine(final + noted) : end.reason ?? "";
  const { result, answer, endedAt } = await runs.closeRun(run, { ...end, text: text + noted, summary, ...opts });
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
  if (answer && !finished) await announce(answer);
  const thread = await threadsRepo().threadById(run.roomId, run.threadId);
  // A run replaced as dead closes without its thread, which now shows the newer run.
  if (thread?.runId === run.runId) await notifyRun(run.roomId, thread, last.seq);
  return result;
}
