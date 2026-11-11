import { describe, expect, it } from "vitest";
import type { Agent } from "../threads/types.js";
import {
  BUILT_IN, agentModel, agentName, agentOrDefault, canChange, instructionsText, mapKinds, mentionedAgent, toolKinds,
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
  it("dedupes and sorts", () => expect(toolKinds(["web", "github", "web"])).toEqual(["github", "web"]));
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

it("mapKinds keeps the kinds the room offers", () => {
  expect(mapKinds(["github", "mcp", "sandbox", "web"], ["mcp", "sandbox", "web"])).toEqual({
    kept: ["mcp", "sandbox", "web"], dropped: ["github"],
  });
});

describe("mentionedAgent", () => {
  const reviewer = agent("reviewer");
  const reviewer2 = agent("reviewer-2");
  const agents = [BUILT_IN, reviewer, reviewer2];
  it("picks the earliest mention", () => {
    expect(mentionedAgent("hi @reviewer and @agent", agents)).toBe(reviewer);
    expect(mentionedAgent("@agent, ask @reviewer", agents)).toBe(BUILT_IN);
    expect(mentionedAgent("hey @Reviewer", agents)).toBe(reviewer);
  });
  it("matches the whole name", () => expect(mentionedAgent("@reviewer-2 go", agents)).toBe(reviewer2));
  it.each(["`@reviewer`", "```\n@reviewer\n```", "a@reviewer.com", "nobody here"])("finds none in %j", (text) =>
    expect(mentionedAgent(text, agents)).toBeNull());
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
