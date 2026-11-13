import { requireOffered } from "../../agents/kinds.js";
import { KINDS, agentModel, agentName, canAgentEdit, grantRefusal, instructionsText, toolKinds } from "../../agents/model.js";
import { agentsRepo, type AgentInput } from "../../agents/repo.js";
import { NotFound, ValidationError } from "../../lib/errors.js";
import type { Agent } from "../../threads/types.js";
import { answer } from "../answer.js";
import type { Tool, ToolEnv } from "../types.js";

const stage = () => process.env.STAGE ?? "";
const nameOf = (raw: unknown) => String(raw ?? "").trim().replace(/^@/, "").toLowerCase();
const noSuchAgent = (name: string) => `There's no @${name} in this room.`;

/** The agents the model named, as ids. Only the room's live agents can be named. */
function delegateIds(raw: unknown, agents: Agent[]): string[] {
  if (!Array.isArray(raw)) throw new ValidationError("delegates is a list of agent names.");
  return [...new Set(raw.map((n) => {
    const found = agents.find((a) => a.name === nameOf(n));
    if (!found) throw new ValidationError(noSuchAgent(nameOf(n)));
    return found.agentId;
  }))];
}

/** A new agent hands work to the same agents as the one making it unless it says otherwise. */
const newAgent = (input: Record<string, unknown>, agents: Agent[], env: ToolEnv): AgentInput => ({
  name: agentName(input.name), instructions: instructionsText(input.instructions), tools: toolKinds(input.tools),
  model: agentModel(input.model, stage()),
  delegates: input.delegates === undefined ? env.room.delegates : delegateIds(input.delegates, agents),
});

const changes = (input: Record<string, unknown>, agents: Agent[]): Partial<AgentInput> => ({
  ...(input.name !== undefined && { name: agentName(input.name) }),
  ...(input.instructions !== undefined && { instructions: instructionsText(input.instructions) }),
  ...(input.tools !== undefined && { tools: toolKinds(input.tools) }),
  ...(input.model !== undefined && { model: agentModel(input.model, stage()) }),
  ...(input.delegates !== undefined && { delegates: delegateIds(input.delegates, agents) }),
});

/**
 * The creator's bound is what its run's agent has now, so an agent that lost a kind can't hand it on later. The model
 * is free: the room's budget caps what any model costs.
 */
function overBound(env: ToolEnv, asked: Pick<AgentInput, "tools" | "delegates">, agents: Agent[]): string | null {
  const { agentName: name, kinds: tools, delegates } = env.room;
  const names = (id: string) => agents.find((a) => a.agentId === id)?.name ?? id;
  return grantRefusal({ name, tools, delegates }, { tools: asked.tools, delegates: asked.delegates ?? [] }, names);
}

/** A validator's refusal is the answer to the model, before anyone is asked. */
async function refusal(work: () => Promise<string | null>): Promise<string | null> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ValidationError) return e.message;
    throw e;
  }
}

const kindsOf = (input: Record<string, unknown>) => (Array.isArray(input.tools) ? input.tools.map(String) : []);

const AGENT_FIELDS = {
  instructions: { type: "string", description: "Its role and how it works; the first line is what other agents read about it." },
  tools: { type: "array", items: { type: "string", enum: KINDS }, description: "Its tool kinds, only ones you have yourself." },
  model: { type: "string", description: "A model pick, or room for the room's default." },
  delegates: { type: "array", items: { type: "string" }, description: "Names of the agents it may hand work to, only ones you may hand work to." },
};

/**
 * An agent sets up agents in its own room, never more capable than itself: the kinds and delegates it gives are ones
 * it has, so "Manage agents" passes on only from an agent that has it. It edits only the agents it made. The agent it
 * makes records it as the maker and the member who approved it, if any, as its owner.
 */
export const AGENT_TOOLS: Tool[] = [
  {
    spec: {
      name: "agent_create",
      description: "Create an agent in this room. It can have only the tools and delegates you have yourself; if it needs "
        + "more, tell people what to add by hand. It hands work to the agents you do unless you list others.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Its @name: a-z, 0-9 and dashes." }, ...AGENT_FIELDS },
        required: ["name", "tools"],
      },
    },
    kind: "room_agents",
    write: true,
    detail: (input) => `@${nameOf(input.name)}`,
    check: (input, env) => refusal(async () => {
      const agents = await agentsRepo().list(env.room.roomId);
      const asked = newAgent(input, agents, env);
      const over = overBound(env, asked, agents);
      if (over) return over;
      await requireOffered(env.room.roomId, asked.tools);
      return null;
    }),
    ask: (input) => `Create @${nameOf(input.name)} (${kindsOf(input).join(", ") || "no tools"})?`,
    run: (input, env) => answer(async () => {
      const { roomId, agentId, agentName: name } = env.room;
      const fields = newAgent(input, await agentsRepo().list(roomId), env);
      const made = await agentsRepo().createByAgent(roomId, fields, { agentId, name }, env.approver);
      return `Created @${made.name}.`;
    }),
  },
  {
    spec: {
      name: "agent_edit",
      description: "Change an agent you created in this room: give only the fields that change. It can have only the "
        + "tools and delegates you have yourself.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "The @name of the agent to change." },
          name: { type: "string", description: "A new @name." }, ...AGENT_FIELDS,
        },
        required: ["agent"],
      },
    },
    kind: "room_agents",
    write: true,
    detail: (input) => `@${nameOf(input.agent)}`,
    check: (input, env) => refusal(async () => {
      const agents = await agentsRepo().list(env.room.roomId);
      const target = agents.find((a) => a.name === nameOf(input.agent));
      if (!target) return noSuchAgent(nameOf(input.agent));
      const patch = changes(input, agents);
      const over = overBound(env, { tools: patch.tools ?? [], delegates: patch.delegates ?? [] }, agents);
      if (over) return over;
      if (!canAgentEdit(target, env.room.agentId)) return `@${env.room.agentName} can edit only the agents it created, never itself.`;
      if (patch.tools) await requireOffered(env.room.roomId, patch.tools, target.tools);
      return null;
    }),
    ask: (input) => `Change @${nameOf(input.agent)}?`,
    run: (input, env) => answer(async () => {
      const { roomId, agentId } = env.room;
      const agents = await agentsRepo().list(roomId);
      const target = agents.find((a) => a.name === nameOf(input.agent));
      if (!target) throw new NotFound(noSuchAgent(nameOf(input.agent)));
      const changed = await agentsRepo().updateByAgent(roomId, target.agentId, changes(input, agents), agentId);
      return `Changed @${changed.name}.`;
    }),
  },
];
