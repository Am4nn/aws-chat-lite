import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN } from "../../agents/model.js";
import { Forbidden } from "../../lib/errors.js";
import type { Agent } from "../../threads/types.js";
import type { ToolEnv } from "../types.js";
import { AGENT_TOOLS } from "./agents.js";

const agent = (agentId: string, name: string, over: Partial<Agent> = {}): Agent => ({
  ...BUILT_IN, agentId, name, builtIn: false, tools: ["web"], createdBy: "u-ann", createdByName: "ann", ...over,
});
const madeByScout = { madeBy: { agentId: "S", name: "scout" }, createdBy: "", createdByName: "" };

const fake = vi.hoisted(() => ({ createByAgent: vi.fn(), updateByAgent: vi.fn(), github: null as unknown }));
vi.mock("../../agents/repo.js", () => ({
  agentsRepo: () => ({
    list: async () => [
      BUILT_IN, agent("H", "helper", { ...madeByScout, tools: ["github"] }), agent("A1", "reviewer"), agent("S", "scout"),
      agent("A2", "writer"),
    ],
    createByAgent: fake.createByAgent,
    updateByAgent: fake.updateByAgent,
  }),
}));
vi.mock("../../connections/repo.js", () => ({ connectionsRepo: () => ({ get: async () => ({ github: fake.github, mcp: [] }) }) }));

const env = {
  room: {
    roomId: "R", threadId: "T", threadNumber: 7, runId: "run7", agentId: "S", agentName: "scout", kinds: ["room_agents", "web"],
    delegates: ["A1"], tainted: false, postCap: 10,
  },
} as ToolEnv;
const withKinds = (kinds: ToolEnv["room"]["kinds"]) => ({ ...env, room: { ...env.room, kinds } });
const bea = { userId: "u-bea", username: "bea" };
const tool = (name: string) => AGENT_TOOLS.find((t) => t.spec.name === name)!;
const create = tool("agent_create");
const edit = tool("agent_edit");

beforeEach(() => {
  vi.clearAllMocks();
  fake.github = null;
  fake.createByAgent.mockImplementation(async (_roomId, input) => ({ ...agent("N", input.name), ...input }));
  fake.updateByAgent.mockImplementation(async (_roomId, agentId, patch) => ({ ...agent(agentId, "helper"), ...patch }));
});

it("are room writes of the Manage agents kind", () => {
  expect(AGENT_TOOLS.map((t) => [t.spec.name, t.kind, t.write])).toEqual([
    ["agent_create", "room_agents", true], ["agent_edit", "room_agents", true],
  ]);
});

describe("agent_create", () => {
  it("creates an agent no stronger than its creator, made by the agent and owned by who approved it", async () => {
    expect(await create.run({ name: "helper", tools: ["web"] }, { ...env, approver: bea })).toEqual({ ok: true, output: "Created @helper." });
    expect(fake.createByAgent).toHaveBeenCalledWith(
      "R", { name: "helper", instructions: "", tools: ["web"], model: "room", delegates: ["A1"] }, { agentId: "S", name: "scout" }, bea,
    );
  });

  it("has no owner but admins and its maker when the room's mode ran it without asking", async () => {
    await create.run({ name: "helper", tools: [] }, env);
    expect(fake.createByAgent).toHaveBeenCalledWith("R", expect.objectContaining({ name: "helper" }), { agentId: "S", name: "scout" }, undefined);
  });

  it("takes delegates by name, with or without the @", async () => {
    expect(await create.check!({ name: "helper", tools: [], delegates: ["@Reviewer"] }, env)).toBeNull();
    await create.run({ name: "helper", tools: [], delegates: ["@Reviewer", "reviewer"] }, env);
    expect(fake.createByAgent.mock.calls[0][1]).toMatchObject({ delegates: ["A1"] });
    expect(await create.check!({ name: "helper", tools: [], delegates: ["nope"] }, env)).toBe("There's no @nope in this room.");
  });

  it("refuses a kind or a delegate the creator lacks before anyone is asked", async () => {
    expect(await create.check!({ name: "helper", tools: ["github"] }, env))
      .toBe("@scout can't give what it doesn't have: github. Ask a member to add it by hand.");
    expect(await create.check!({ name: "helper", tools: ["web", "room_post"], delegates: ["writer"] }, env))
      .toBe("@scout can't give what it doesn't have: room_post, @writer. Ask a member to add it by hand.");
    expect(await create.check!({ name: "helper", tools: ["room_agents", "web"] }, env)).toBeNull();
  });

  it("refuses a kind the room has no connection for, and invalid fields", async () => {
    expect(await create.check!({ name: "helper", tools: ["github"] }, withKinds(["github", "room_agents"]))).toBe("This room has no github connection.");
    expect(await create.check!({ name: "x", tools: [] }, env)).toMatch(/^Agent names use a-z/);
    expect(await create.check!({ name: "helper", tools: ["shell"] }, env)).toBe("Unknown tool kind.");
    expect(await create.check!({ name: "helper", tools: [], model: "gpt" }, env)).toBe("Unknown model.");
  });

  it("asks with the new agent's name and kinds", () => {
    expect(create.ask!({ name: "helper", tools: ["web", "room_read"] }, env)).toBe("Create @helper (web, room_read)?");
    expect(create.ask!({ name: "helper", tools: [] }, env)).toBe("Create @helper (no tools)?");
  });
});

describe("agent_edit", () => {
  const EDIT_ONLY = "@scout can edit only the agents it created, never itself.";

  it("edits an agent it made", async () => {
    expect(await edit.check!({ agent: "@helper", instructions: "x" }, env)).toBeNull();
    expect(await edit.run({ agent: "helper", instructions: "x" }, env)).toEqual({ ok: true, output: "Changed @helper." });
    expect(fake.updateByAgent).toHaveBeenCalledWith("R", "H", { instructions: "x" }, "S");
  });

  it("refuses a person's agent, itself, the built-in and one that isn't there", async () => {
    expect(await edit.check!({ agent: "reviewer", instructions: "x" }, env)).toBe(EDIT_ONLY);
    expect(await edit.check!({ agent: "scout", instructions: "x" }, env)).toBe(EDIT_ONLY);
    expect(await edit.check!({ agent: "agent", instructions: "x" }, env)).toBe(EDIT_ONLY);
    expect(await edit.check!({ agent: "ghost", instructions: "x" }, env)).toBe("There's no @ghost in this room.");
  });

  it("widens only to what the creator has now", async () => {
    expect(await edit.check!({ agent: "helper", tools: ["web", "room_post"], delegates: ["writer"] }, env))
      .toBe("@scout can't give what it doesn't have: room_post, @writer. Ask a member to add it by hand.");
  });

  it("keeps a kind the agent already has after the room lost its connection", async () => {
    expect(await edit.check!({ agent: "helper", tools: ["github"] }, withKinds(["github", "room_agents"]))).toBeNull();
  });

  it("tells the model when the repo refuses", async () => {
    fake.updateByAgent.mockRejectedValue(new Forbidden("An agent can edit only the agents it created, never itself."));
    expect(await edit.run({ agent: "helper", instructions: "x" }, env)).toEqual({
      ok: false, output: "An agent can edit only the agents it created, never itself.",
    });
  });

  it("asks with the agent's name", () => expect(edit.ask!({ agent: "@Helper", instructions: "x" }, env)).toBe("Change @helper?"));
});
