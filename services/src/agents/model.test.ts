import { describe, expect, it } from "vitest";
import type { Agent, Delegates, ToolKind } from "../threads/types.js";
import {
  BUILT_IN, agentModel, agentName, agentOrDefault, canAgentEdit, canChange, delegatesTo, grantRefusal, instructionsText, mapKinds,
  mentionedAgents, toolKinds,
} from "./model.js";

const NAME_RULE = "Agent names use a-z, 0-9 and dashes, 2 to 32 characters, starting with a letter.";

const agent = (name: string, over: Partial<Agent> = {}): Agent => ({
  ...BUILT_IN, agentId: `id-${name}`, name, builtIn: false, createdBy: "u-ann", createdByName: "ann", ...over,
});

describe("agentName", () => {
  it("trims and lowercases", () => expect(agentName(" Reviewer ")).toBe("reviewer"));
  it.each(["r", "1bot", "a".repeat(33), "has space", "", 7])("refuses %j", (raw) => expect(() => agentName(raw)).toThrow(NAME_RULE));
  it.each(["agent", "Everyone", "schedule"])("keeps %s for mentions", (raw) =>
    expect(() => agentName(raw)).toThrow(`@${raw.toLowerCase()} is reserved.`));
});

describe("instructionsText", () => {
  it("defaults to none and trims", () => {
    expect(instructionsText(undefined)).toBe("");
    expect(instructionsText("  Be brief.\n")).toBe("Be brief.");
  });
  it.each(["a".repeat(4001), 3])("refuses %j", (raw) => expect(() => instructionsText(raw)).toThrow("Instructions are up to 4,000 characters."));
});

describe("toolKinds", () => {
  it("dedupes and sorts", () => expect(toolKinds(["web", "images", "github", "web"])).toEqual(["github", "images", "web"]));
  it("keeps the room kinds off the built-in @agent, and accepts them on any agent", () => {
    expect(BUILT_IN.tools).toEqual(["github", "images", "mcp", "sandbox", "web"]);
    expect(toolKinds(["room_post", "web", "room_read"])).toEqual(["room_post", "room_read", "web"]);
    expect(() => toolKinds(["room_admin"])).toThrow("Unknown tool kind.");
  });
  it("gives the built-in @agent a role, whose first line other agents read when they hand it work", () =>
    expect(BUILT_IN.instructions.split("\n")).toEqual([
      "The room's generalist.",
      "Take any question or task: answer directly when you can, and research or run code when it needs checking. If another agent in the room is the specialist for part of it, hand that part to them. Keep answers short and lead with the result; ask one question when the request is unclear.",
    ]));
  it.each([["shell"], "web", undefined])("refuses %j", (raw) => expect(() => toolKinds(raw)).toThrow("Unknown tool kind."));
});

describe("agentModel", () => {
  it("takes a pick the stage offers, or the room's default", () => {
    expect(agentModel("haiku", "local")).toBe("haiku");
    expect(agentModel("room", "local")).toBe("room");
    expect(agentModel(undefined, "local")).toBe("room");
  });
  it("refuses an unknown model", () => expect(() => agentModel("gpt", "local")).toThrow("Unknown model."));
});

describe("canChange", () => {
  const scout = agent("scout");
  it("lets the creator or an admin change an agent", () => {
    expect(canChange(scout, { userId: "u-ann", role: "member" })).toBe(true);
    expect(canChange(scout, { userId: "u-bob", role: "member" })).toBe(false);
    expect(canChange(scout, { userId: "u-bob", role: "admin" })).toBe(true);
  });
  it("lets only admins change the built-in", () => {
    expect(canChange(BUILT_IN, { userId: "u-ann", role: "member" })).toBe(false);
    expect(canChange(BUILT_IN, { userId: "u-ann", role: "owner" })).toBe(true);
  });
});

describe("grantRefusal", () => {
  const scout = { name: "scout", tools: ["web", "room_post"] as ToolKind[], delegates: ["A1"] as Delegates };
  const named = (id: string) => ({ A1: "reviewer", A2: "writer" })[id] ?? id;
  it("lets an agent grant only the kinds and delegates it has", () => {
    expect(grantRefusal(scout, { tools: ["web"], delegates: ["A1"] }, named)).toBeNull();
    expect(grantRefusal(scout, { tools: ["web", "github", "room_agents"], delegates: ["A1", "A2"] }, named))
      .toBe("@scout can't give what it doesn't have: github, room_agents, @writer. Ask a member to add it by hand.");
  });
  it("gives every agent only when it may hand work to every agent itself", () => {
    expect(grantRefusal(scout, { tools: [], delegates: "all" }, named))
      .toBe("@scout can't give what it doesn't have: any agent. Ask a member to add it by hand.");
    expect(grantRefusal({ ...scout, delegates: "all" }, { tools: [], delegates: "all" }, named)).toBeNull();
    expect(grantRefusal({ ...scout, delegates: "all" }, { tools: [], delegates: ["A2"] }, named)).toBeNull();
  });
});

describe("canAgentEdit", () => {
  const madeBy = { agentId: "S", name: "scout" };
  it("lets an agent edit the agents it made", () => expect(canAgentEdit(agent("b", { agentId: "B", madeBy }), "S")).toBe(true));
  it("never one a person or another agent made, itself, a deleted one or the built-in", () => {
    expect(canAgentEdit(agent("b", { agentId: "B" }), "S")).toBe(false);
    expect(canAgentEdit(agent("b", { agentId: "B", madeBy: { agentId: "X", name: "other" } }), "S")).toBe(false);
    expect(canAgentEdit(agent("s", { agentId: "S", madeBy }), "S")).toBe(false);
    expect(canAgentEdit({ ...agent("b", { agentId: "B", madeBy }), deleted: true }, "S")).toBe(false);
    expect(canAgentEdit({ ...BUILT_IN, madeBy }, "S")).toBe(false);
  });
});

it("delegatesTo: every agent by default, else the listed ones", () => {
  expect(delegatesTo({}, "A2")).toBe(true);
  expect(delegatesTo({ delegates: "all" }, "A2")).toBe(true);
  expect(delegatesTo({ delegates: ["A1"] }, "A2")).toBe(false);
  expect(delegatesTo({ delegates: ["A1"] }, "A1")).toBe(true);
});

it("mapKinds keeps the kinds the room offers", () => {
  expect(mapKinds(["github", "mcp", "sandbox", "web"], ["mcp", "sandbox", "web"])).toEqual({
    kept: ["mcp", "sandbox", "web"], dropped: ["github"],
  });
});

describe("mentionedAgents", () => {
  const reviewer = agent("reviewer");
  const reviewer2 = agent("reviewer-2");
  const agents = [BUILT_IN, reviewer, reviewer2];
  it("lists each agent named, in the order the text names them", () => {
    expect(mentionedAgents("hi @reviewer and @agent", agents)).toEqual([reviewer, BUILT_IN]);
    expect(mentionedAgents("@agent, ask @reviewer, then @agent again", agents)).toEqual([BUILT_IN, reviewer]);
    expect(mentionedAgents("hey @Reviewer", agents)).toEqual([reviewer]);
  });
  it("matches the whole name", () => expect(mentionedAgents("@reviewer-2 go", agents)).toEqual([reviewer2]));
  it.each(["`@reviewer`", "```\n@reviewer\n```", "a@reviewer.com", "nobody here"])("finds none in %j", (text) =>
    expect(mentionedAgents(text, agents)).toEqual([]));
});

describe("agentOrDefault", () => {
  it("falls back to the built-in for a missing or deleted agent", () => {
    expect(agentOrDefault(null)).toBe(BUILT_IN);
    expect(agentOrDefault({ ...agent("scout"), deleted: true })).toBe(BUILT_IN);
  });
  it("hands back a live agent without the flag", () => {
    expect(agentOrDefault({ ...agent("scout"), deleted: false })).toEqual(agent("scout"));
  });
});
