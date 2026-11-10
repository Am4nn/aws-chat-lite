import { budgetRepo } from "../budget/repo.js";
import { broadcastToRoom } from "../live/broadcast.js";
import type { ThreadSummary } from "../threads/types.js";

/**
 * Tells the room where a run stands: its thread, the newest event seq and the room's budget, so no client has to
 * refetch. Best effort, like every broadcast: a client that misses one gets the thread on its next room load.
 */
export async function notifyRun(roomId: string, thread: ThreadSummary, lastSeq: number): Promise<void> {
  try {
    const budget = await budgetRepo().get(roomId, new Date());
    await broadcastToRoom(roomId, { type: "run.updated", roomId, thread, lastSeq, budget });
  } catch (e) {
    console.error("run.updated broadcast failed", roomId, e);
  }
}
