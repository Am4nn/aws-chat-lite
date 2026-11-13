import { describe, expect, it } from "vitest";
import type { Agent, RoomSummary } from "../types";
import { agentLabel, canEditAgent, copyTargets, copyToast, madeByLine } from "./agents";

const agent = (over: Partial<Agent> = {}): Agent => ({
  agentId: "a1", name: "reviewer", instructions: "", tools: ["web"], model: "room", builtIn: false,
  createdBy: "u1", createdByName: "aman", createdAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T10:00:00Z", ...over,
});
const builtIn = agent({ agentId: "agent", name: "agent", builtIn: true, createdBy: "", createdByName: "" });

describe("canEditAgent", () => {
  it("lets the creator and admins change an agent, and no other member", () => {
    expect(canEditAgent(agent(), { userId: "u1", role: "member" })).toBe(true);
    expect(canEditAgent(agent(), { userId: "u2", role: "member" })).toBe(false);
    expect(canEditAgent(agent(), { userId: "u2", role: "admin" })).toBe(true);
    expect(canEditAgent(agent(), { userId: "u2", role: "owner" })).toBe(true);
  });
  it("leaves the built-in @agent to admins", () => {
    expect(canEditAgent(builtIn, { userId: "u1", role: "member" })).toBe(false);
    expect(canEditAgent(builtIn, { userId: "u1", role: "admin" })).toBe(true);
  });
});

describe("copyTargets", () => {
  it("offers only the other rooms where I'm an admin or the owner", () => {
    const rooms: RoomSummary[] = [
      { roomId: "here", name: "Here", role: "owner", mentions: 0 },
      { roomId: "r2", name: "Admin room", role: "admin", mentions: 0 },
      { roomId: "r3", name: "Member room", role: "member", mentions: 0 },
      { roomId: "r4", name: "Owned", role: "owner", mentions: 0 },
    ];
    expect(copyTargets(rooms, "here").map((r) => r.roomId)).toEqual(["r2", "r4"]);
  });
});

describe("copyToast", () => {
  const copied = agent({ name: "scout-2" });
  it("names the room and the copy", () => {
    expect(copyToast("Design", { agent: copied, dropped: [], schedules: { copied: 0, skipped: 0 } })).toBe("Copied to Design as @scout-2");
  });
  it("adds the tool kinds the room can't offer and the schedules that came along", () => {
    expect(copyToast("Design", { agent: copied, dropped: ["github"], schedules: { copied: 1, skipped: 0 } }))
      .toBe("Copied to Design as @scout-2 · not connected there: github · 1 schedule copied, off");
    expect(copyToast("Design", { agent: copied, dropped: ["github", "mcp"], schedules: { copied: 2, skipped: 1 } }))
      .toBe("Copied to Design as @scout-2 · not connected there: github, mcp · 2 schedules copied, off · 1 left out (that room has 5)");
  });
});

describe("agentLabel", () => {
  it("names the thread's agent, and @agent for one that is gone", () => {
    expect(agentLabel("a1", [builtIn, agent()])).toBe("@reviewer");
    expect(agentLabel("gone", [builtIn, agent()])).toBe("@agent");
  });
});

describe("madeByLine", () => {
  it("says who made an agent, and who approved one an agent made", () => {
    expect(madeByLine(builtIn)).toBe("built in");
    expect(madeByLine(agent())).toBe("by aman");
    expect(madeByLine(agent({ madeBy: { agentId: "S", name: "scout" }, createdByName: "bea" }))).toBe("by @scout · approved by bea");
    expect(madeByLine(agent({ madeBy: { agentId: "S", name: "scout" }, createdByName: "" }))).toBe("by @scout");
  });
});
