import { describe, expect, it, vi } from "vitest";

vi.mock("../connections/repo.js", () => ({ connectionsRepo: () => ({ get: async () => ({ github: null, mcp: [] }) }) }));

const { availableKinds } = await import("./kinds.js");

describe("availableKinds", () => {
  it("offers the room kinds in every room", async () => {
    expect(await availableKinds("R")).toEqual(expect.arrayContaining(["room_read", "room_post", "room_agents"]));
  });
});
