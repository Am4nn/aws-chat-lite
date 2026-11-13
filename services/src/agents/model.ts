import { CODE } from "../chat/mentions.js";
import { ValidationError } from "../lib/errors.js";
import { parsePick } from "../models/picks.js";
import { can, type Role } from "../rooms/access.js";
import type { Agent, AgentModel, ToolKind } from "../threads/types.js";

/** Besides the built-in `@agent`. */
export const MAX_AGENTS = 20;
const MAX_INSTRUCTIONS = 4000;
const NAME = /^[a-z][a-z0-9-]{1,31}$/;
/** Mentions already give these a meaning: the built-in agent, the whole room and the scheduled messages' author. */
const RESERVED = new Set(["agent", "everyone", "schedule"]);
const KINDS: ToolKind[] = ["github", "images", "mcp", "sandbox", "web"];

/** Virtual until an admin edits it, so every room has it without a write at room creation. */
export const BUILT_IN: Agent = {
  agentId: "agent", name: "agent", instructions: "", tools: KINDS, model: "room",
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
