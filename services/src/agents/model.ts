import { CODE } from "../chat/mentions.js";
import { ValidationError } from "../lib/errors.js";
import { parsePick } from "../models/picks.js";
import { can, type Role } from "../rooms/access.js";
import type { Agent, AgentModel, Delegates, ToolKind } from "../threads/types.js";

/** Besides the built-in `@agent`. */
export const MAX_AGENTS = 20;
const MAX_INSTRUCTIONS = 4000;
const NAME = /^[a-z][a-z0-9-]{1,31}$/;
/** Mentions already give these a meaning: the built-in agent, the whole room and the scheduled messages' author. */
const RESERVED = new Set(["agent", "everyone", "schedule"]);
const BASE_KINDS: ToolKind[] = ["github", "images", "mcp", "sandbox", "web"];
export const ROOM_KINDS: ToolKind[] = ["room_agents", "room_post", "room_read"];
export const KINDS: ToolKind[] = [...BASE_KINDS, ...ROOM_KINDS].sort();

/**
 * Virtual until an admin edits it, so every room has it without a write at room creation. The first line of its role
 * is what other agents read when they hand it work.
 */
export const BUILT_IN: Agent = {
  agentId: "agent", name: "agent", model: "room", tools: BASE_KINDS,
  instructions: "The room's generalist.\n"
    + "Take any question or task: answer directly when you can, and research or run code when it needs checking. "
    + "If another agent in the room is the specialist for part of it, hand that part to them. "
    + "Keep answers short and lead with the result; ask one question when the request is unclear.",
  builtIn: true, createdBy: "", createdByName: "", createdAt: "", updatedAt: "",
};

export function agentName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!NAME.test(name)) throw new ValidationError("Agent names use a-z, 0-9 and dashes, 2 to 32 characters, starting with a letter.");
  if (RESERVED.has(name)) throw new ValidationError(`@${name} is reserved.`);
  return name;
}

export function instructionsText(raw: unknown): string {
  const text = raw === undefined ? "" : typeof raw === "string" ? raw.trim() : null;
  if (text === null || text.length > MAX_INSTRUCTIONS) throw new ValidationError("Instructions are up to 4,000 characters.");
  return text;
}

export function toolKinds(raw: unknown): ToolKind[] {
  if (!Array.isArray(raw) || !raw.every((k) => KINDS.includes(k))) throw new ValidationError("Unknown tool kind.");
  return KINDS.filter((k) => raw.includes(k));
}

export function agentModel(raw: unknown, stage: string): AgentModel {
  return raw === "room" ? "room" : parsePick(raw, stage) ?? "room";
}

export function canChange(agent: Agent, actor: { userId: string; role: Role }): boolean {
  return can("manageAgents", actor.role) || (!agent.builtIn && agent.createdBy === actor.userId);
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** At most every agent a room can hold: the built-in and `MAX_AGENTS` more. */
export function delegateList(raw: unknown): Delegates {
  if (raw === "all") return "all";
  if (!Array.isArray(raw) || raw.length > MAX_AGENTS + 1 || !raw.every((id) => typeof id === "string" && AGENT_ID.test(id))) {
    throw new ValidationError('Delegates are "all" or a list of agent ids.');
  }
  return [...new Set<string>(raw)];
}

export const delegatesTo = (agent: Pick<Agent, "delegates">, agentId: string): boolean =>
  agent.delegates === undefined || agent.delegates === "all" || agent.delegates.includes(agentId);

/**
 * Why an agent may not give an agent these kinds and delegates, or null. It gives only what it has itself, so nothing
 * it makes or edits can do more than it can; `names` turns a delegate's id into the name the refusal shows.
 */
export function grantRefusal(
  creator: { name: string; tools: ToolKind[]; delegates: Delegates }, asked: { tools: ToolKind[]; delegates: Delegates },
  names: (agentId: string) => string,
): string | null {
  const kinds = asked.tools.filter((k) => !creator.tools.includes(k));
  const delegates = asked.delegates === "all"
    ? creator.delegates === "all" ? [] : ["any agent"]
    : asked.delegates.filter((id) => !delegatesTo(creator, id)).map((id) => `@${names(id)}`);
  const missing = [...kinds, ...delegates];
  return missing.length ? `@${creator.name} can't give what it doesn't have: ${missing.join(", ")}. Ask a member to add it by hand.` : null;
}

/** An agent edits only the agents it made: never itself, a person's, another agent's or the built-in. */
export const canAgentEdit = (target: Agent & { deleted?: boolean }, agentId: string): boolean =>
  !target.builtIn && !target.deleted && target.madeBy?.agentId === agentId && target.agentId !== agentId;

/** An agent copied into another room keeps only the kinds that room offers. */
export function mapKinds(kinds: ToolKind[], available: ToolKind[]): { kept: ToolKind[]; dropped: ToolKind[] } {
  return { kept: kinds.filter((k) => available.includes(k)), dropped: kinds.filter((k) => !available.includes(k)) };
}

/**
 * The agents the text names outside code, in the order it first names them. An `@` after a word character is an email
 * address, and the name must end where the mention does, so `@reviewer-2` never names `@reviewer`.
 */
export function mentionedAgents<T extends { name: string }>(text: string, agents: T[]): T[] {
  const plain = text.replace(CODE, " ");
  return agents
    .map((agent) => ({ agent, at: plain.search(new RegExp(`(?<!\\w)@${agent.name}(?![\\w-])`, "i")) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ agent }) => agent);
}

/** A thread whose agent was deleted is answered by the built-in one. */
export function agentOrDefault(agent?: (Agent & { deleted?: boolean }) | null): Agent {
  if (!agent || agent.deleted) return BUILT_IN;
  const { deleted: _deleted, ...live } = agent;
  return live;
}
