import { wakeRun } from "../approvals/decide.js";
import { approvalsRepo } from "../approvals/repo.js";
import type { User } from "../lib/auth.js";
import { Conflict, NotFound } from "../lib/errors.js";
import { requireMember } from "../chat/membership.js";
import { threadsRepo } from "../threads/repo.js";
import { finishRun } from "./finish.js";
import { DEAD_REASON } from "./model.js";
import { runsRepo } from "./repo.js";

/**
 * Any member may stop the thread's run. A live run gets a flag it reads within a second; one waiting on an approval
 * sleeps until it is woken, so the stop also cancels the approval and wakes it. A run past its `deadAt` can't be alive
 * to read the flag, so it is closed here, which frees the thread. The run item, not the thread, says whether it is
 * running: the thread already shows a dead run as failed.
 */
export async function requestStop(user: User, roomId: string, threadId: string): Promise<{ runId: string }> {
  await requireMember(roomId, user.userId);
  const thread = await threadsRepo().threadById(roomId, threadId);
  if (!thread) throw new NotFound("Thread not found.");
  const runs = runsRepo();
  const run = thread.runId ? await runs.getRun(thread.runId) : undefined;
  if (run?.status === "running") {
    if (Date.now() > Date.parse(run.deadAt)) {
      await finishRun(run, { status: "failed", reason: DEAD_REASON }, { seenSeq: run.seenSeq, force: true });
      return { runId: run.runId };
    }
    const flagged = await runs.flagStop(run.runId, user.username);
    if (flagged) {
      const callbackId = flagged.waitingStep && await approvalsRepo().cancel(run.runId, flagged.waitingStep, user.username);
      if (callbackId) await wakeRun(callbackId);
      return { runId: run.runId };
    }
  }
  throw new Conflict("Nothing is running.");
}
