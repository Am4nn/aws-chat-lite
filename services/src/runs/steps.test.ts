import { expect, it, vi } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import type { Agent } from "../threads/types.js";
import { load } from "./steps.js";

const agent = (agentId: string, over: Partial<Agent> = {}): Agent => ({ ...BUILT_IN, agentId, name: agentId.toLowerCase(), builtIn: false, ...over });
const fake = vi.hoisted(() => ({ agents: [] as Agent[] }));
vi.mock("./repo.js", () => ({ runsRepo: () => ({ getRun: async () => ({ runId: "RUN", roomId: "R", threadId: "T", agentId: "S", status: "running" }) }) }));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => ({ threadById: async () => ({ name: "ideas" }) }) }));
vi.mock("../agents/repo.js", () => ({
  agentsRepo: () => ({ byId: async (_r: string, id: string) => fake.agents.find((a) => a.agentId === id) ?? null, list: async () => fake.agents }),
}));

it("offers a run only the agents its agent may delegate to", async () => {
  fake.agents = [BUILT_IN, agent("A1"), agent("A2"), agent("S", { delegates: ["A1"] })];
  expect((await load("RUN"))!.others.map((o) => o.agentId)).toEqual(["A1"]);
  fake.agents = [BUILT_IN, agent("A1"), agent("S")];
  expect((await load("RUN"))!.others.map((o) => o.agentId)).toEqual(["agent", "A1"]);
});
