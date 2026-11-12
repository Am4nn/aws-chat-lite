import { budgetRepo } from "../budget/repo.js";
import { bestEffort } from "../lib/best-effort.js";
import { broadcastToRoom } from "../live/broadcast.js";
import type { ThreadSummary } from "../threads/types.js";

/**
 * Tells the room where a run stands: its thread, the newest event seq and the room's budget, so no client has to
 * refetch. Best effort, like every broadcast: a client that misses one gets the thread on its next room load. A run
 * that no longer owns its thread (null) has nothing to tell.
 */
export async function notifyRun(roomId: string, thread: ThreadSummary | null, lastSeq: number): Promise<void> {
  if (!thread) return;
  await bestEffort("run.updated broadcast", async () => {
    const budget = await budgetRepo().get(roomId, new Date());
    await broadcastToRoom(roomId, { type: "run.updated", roomId, thread, lastSeq, budget });
  });
}
