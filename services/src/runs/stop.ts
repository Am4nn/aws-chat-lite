import { Conflict, NotFound } from "../lib/errors.js";
import { requireMember } from "../chat/membership.js";
import { threadsRepo } from "../threads/repo.js";
import { finishRun } from "./finish.js";
import { DEAD_AFTER_MS } from "./model.js";
import { runsRepo } from "./repo.js";

interface User { userId: string; username: string }

/**
 * Any member may stop the thread's run. A live run gets a flag it reads within a second. A run older than its
 * execution timeout can't be alive to read it, so it is closed here, which frees the thread.
 */
export async function requestStop(user: User, roomId: string, threadId: string): Promise<{ runId: string }> {
  await requireMember(roomId, user.userId);
  const thread = await threadsRepo().threadById(roomId, threadId);
  if (!thread) throw new NotFound("Thread not found.");
  const runs = runsRepo();
  if (thread.status === "running" && thread.runId) {
    if (Date.now() - Date.parse(thread.startedAt ?? "") > DEAD_AFTER_MS) {
      const run = await runs.getRun(thread.runId);
      if (run?.status === "running") {
        await finishRun(run, { status: "failed", reason: "The run stopped responding." }, { seenSeq: run.seenSeq, force: true });
        return { runId: run.runId };
      }
    } else if (await runs.flagStop(thread.runId, user.username)) {
      return { runId: thread.runId };
    }
  }
  throw new Conflict("Nothing is running.");
}
