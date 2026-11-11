import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { requireMember } from "../chat/membership.js";
import type { User } from "../lib/auth.js";
import { docClient, tableName } from "../lib/db.js";
import { Forbidden, NotFound, ValidationError } from "../lib/errors.js";
import { roomKey } from "../lib/keys.js";
import { can } from "../rooms/access.js";
import { schedulesRepo } from "../schedules/repo.js";
import type { Agent, ToolKind } from "../threads/types.js";
import { availableKinds } from "./kinds.js";
import { BUILT_IN, mapKinds } from "./model.js";
import { BUILT_IN_REFUSAL, agentsRepo } from "./repo.js";

type CopyResult = { agent: Agent; dropped: ToolKind[]; schedules: { copied: number; skipped: number } };

/** Chats sort by creation time, so the first is the room's oldest (`#general`, unless renamed). */
async function oldestChat(roomId: string): Promise<string | undefined> {
  const { Items = [] } = await docClient().send(new QueryCommand({
    TableName: tableName(), KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", Limit: 1, ProjectionExpression: "chatId",
    ExpressionAttributeValues: { ":p": roomKey(roomId), ":c": "CHAT#" },
  }));
  return Items[0]?.chatId as string | undefined;
}

/**
 * The agent's definition and schedules go into a room the caller admins; its threads, memory and files stay behind.
 * It keeps only the tool kinds that room offers, takes the next free name there, and its schedules arrive switched
 * off, posting into the room's oldest chat for now, as the source room's chats mean nothing in the target.
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
  const chatId = await oldestChat(toRoomId);
  if (!chatId) return { agent, dropped, schedules: { copied: 0, skipped: copies.length } };
  return { agent, dropped, schedules: await schedules.createCopies(toRoomId, copies, chatId) };
}
