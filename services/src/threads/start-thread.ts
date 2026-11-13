import { BUILT_IN, mentionedAgents } from "../agents/model.js";
import { agentsRepo } from "../agents/repo.js";
import type { User } from "../lib/auth.js";
import { NotFound, ValidationError } from "../lib/errors.js";
import type { Message } from "../chat/model.js";
import { chatRepo } from "../chat/repo.js";
import { parsePick } from "../models/picks.js";
import { startOrSteer } from "../runs/start.js";
import { threadsRepo } from "./repo.js";
import type { ThreadSummary } from "./types.js";

/** The agent picked for the thread, which must be one of the room's; without a pick, the first the text mentions. */
async function threadAgent(roomId: string, agentId: unknown, text: string): Promise<string> {
  const agents = agentsRepo();
  if (agentId === undefined) return (mentionedAgents(text, await agents.list(roomId))[0] ?? BUILT_IN).agentId;
  const agent = typeof agentId === "string" ? await agents.byId(roomId, agentId) : null;
  if (!agent || agent.deleted) throw new NotFound("No such agent.");
  return agent.agentId;
}

/**
 * A new agent thread with its first message, and the run that answers it. With no `model`, the agent's model or the
 * room default answers. A new thread holds only this text (files come over the socket), so no pick is refused for
 * privacy here. The message is admitted first, so only a member learns which agents the room has.
 */
export async function startThread(
  user: User, roomId: string, input: { text: unknown; clientId: string; model?: unknown; agentId?: unknown },
): Promise<{ thread: ThreadSummary; message: Message }> {
  if (typeof input.text !== "string" || !input.text.trim()) throw new ValidationError("A new thread needs a first message.");
  const pick = parsePick(input.model, process.env.STAGE ?? "");
  const threads = threadsRepo();
  const admitted = await chatRepo().admit(user, { roomId, text: input.text });
  const agentId = await threadAgent(roomId, input.agentId, admitted.text);
  const created = await threads.createThread(user, roomId, { text: input.text, clientId: input.clientId, admitted, agentId });
  // The thread and its message exist now, so a failed start is no reason to fail the request: a client that
  // retried would make a second thread. The next message in the thread starts the run.
  try {
    await startOrSteer(user, roomId, created.thread.threadId, created.message, pick);
  } catch (e) {
    console.error("run start failed", roomId, created.thread.threadId, e);
  }
  // Read again so the answer shows the run that just started.
  const thread = await threads.threadById(roomId, created.thread.threadId) ?? created.thread;
  return { thread, message: created.message };
}
