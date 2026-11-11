import { wakeRun } from "../approvals/decide.js";
import { approvalsRepo } from "../approvals/repo.js";
import { Conflict, NotFound } from "../lib/errors.js";
import { requireMember } from "../chat/membership.js";
import { threadsRepo } from "../threads/repo.js";
import { finishRun } from "./finish.js";
import { runsRepo } from "./repo.js";

interface User { userId: string; username: string }

/**
 * Any member may stop the thread's run. A live run gets a flag it reads within a second; one waiting on an approval
 * sleeps until it is woken, so the stop also cancels the approval and wakes it. A run past its `deadAt` can't be alive
 * to read the flag, so it is closed here, which frees the thread.
 */
export async function requestStop(user: User, roomId: string, threadId: string): Promise<{ runId: string }> {
  await requireMember(roomId, user.userId);
  const thread = await threadsRepo().threadById(roomId, threadId);
  if (!thread) throw new NotFound("Thread not found.");
  const runs = runsRepo();
  const live = (thread.status === "running" || thread.status === "waiting") && thread.runId;
  const run = live ? await runs.getRun(live) : undefined;
  if (run?.status === "running") {
    if (Date.now() > Date.parse(run.deadAt)) {
      await finishRun(run, { status: "failed", reason: "The run stopped responding." }, { seenSeq: run.seenSeq, force: true });
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
