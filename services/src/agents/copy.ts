import { requireMember } from "../rooms/membership.js";
import type { User } from "../lib/auth.js";
import { Forbidden, NotFound, ValidationError } from "../lib/errors.js";
import { can } from "../rooms/access.js";
import { defaultChatId } from "../rooms/repo.js";
import { schedulesRepo } from "../schedules/repo.js";
import type { Agent, ToolKind } from "../threads/types.js";
import { availableKinds } from "./kinds.js";
import { BUILT_IN, mapKinds } from "./model.js";
import { BUILT_IN_REFUSAL, agentsRepo } from "./repo.js";

type CopyResult = { agent: Agent; dropped: ToolKind[]; schedules: { copied: number; skipped: number } };

/**
 * The agent's definition and schedules go into a room the caller admins; its threads, memory and files stay behind.
 * It keeps only the tool kinds that room offers, takes the next free name there, and its schedules arrive switched
 * off, posting into the room's default chat for now, as the source room's chats mean nothing in the target.
 */
export async function copyAgent(user: User, from: { roomId: string; agentId: string }, toRoomId: string): Promise<CopyResult> {
  await requireMember(from.roomId, user.userId);
  if (from.agentId === BUILT_IN.agentId) throw new ValidationError(BUILT_IN_REFUSAL);
  const agents = agentsRepo();
  const source = await agents.byId(from.roomId, from.agentId);
  if (!source || source.deleted) throw new NotFound("No such agent.");
  if (!can("manageAgents", await requireMember(toRoomId, user.userId, { writing: true }))) {
    throw new Forbidden("You can copy agents only into rooms where you're an admin.");
  }
  const { kept, dropped } = mapKinds(source.tools, await availableKinds(toRoomId));
  const agent = await agents.create(user, toRoomId, {
    name: source.name, instructions: source.instructions, tools: kept, model: source.model,
  }, { unique: true });
  const schedules = schedulesRepo();
  const its = (await schedules.list(user, from.roomId)).schedules.filter((s) => s.agentId === source.agentId);
  if (!its.length) return { agent, dropped, schedules: { copied: 0, skipped: 0 } };
  const copies = its.map(({ title, prompt, cadence }) => ({
    agentId: agent.agentId, title, prompt, cadence, createdBy: user.userId, createdByName: user.username,
  }));
  // A schedule with no chat would post nowhere, so a room without one gets none and the copier hears how many.
  const chatId = await defaultChatId(toRoomId);
  if (!chatId) return { agent, dropped, schedules: { copied: 0, skipped: copies.length } };
  return { agent, dropped, schedules: await schedules.createCopies(toRoomId, copies, chatId) };
}
