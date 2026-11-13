import { describe, expect, it } from "vitest";
import type { McpConnection } from "../threads/types.js";
import { pkce, userInstallations } from "../connections/github-sign-in.js";
import { fakeSignInPage } from "./fake-github.js";
import { findTool, roomTools, toolEnv } from "./index.js";
import type { ToolEnv } from "./types.js";

const conn = (status: McpConnection["status"]): McpConnection => ({
  name: "test", url: "http://127.0.0.1:4710/mcp", auth: "oauth", status, toolCount: 2, toolsAt: "2026-11-11T00:00:00Z", addedBy: "aman",
  addedAt: "2026-11-11T00:00:00Z", tools: [
    { name: "echo", description: "Repeats the text.", inputSchema: { type: "object" }, readOnly: true },
    { name: "add_note", description: "Saves a note.", inputSchema: { type: "object" }, readOnly: false },
  ],
});
const noMcp = { roomId: "r1", mcp: [] };
const names = (opts: { github: boolean; privateOk: boolean; mcp?: McpConnection[] }) =>
  roomTools({ roomId: "r1", mcp: [], ...opts }).map((t) => t.spec.name);
const memory = ["memory_save", "memory_update", "memory_forget"];
const roomRead = ["room_list", "room_read", "room_search", "room_members"];
const github = { installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "aman", addedAt: "2026-11-11T00:00:00Z" };

describe("roomTools", () => {
  it("offers the web and memory tools always and GitHub's only with a connection and a model that may see private content", () => {
    expect(names({ github: false, privateOk: true })).toEqual(["web_search", "web_fetch", ...memory, ...roomRead]);
    expect(names({ github: true, privateOk: false })).toEqual(["web_search", "web_fetch", ...memory]);
    const all = names({ github: true, privateOk: true });
    expect(all.filter((n) => n.startsWith("github_"))).toHaveLength(9);
  });

  it("offers a signed-in MCP server's tools, only to a model that may see private content", () => {
    expect(names({ github: false, privateOk: true, mcp: [conn("connected")] })).toEqual([
      "web_search", "web_fetch", "mcp__test__echo", "mcp__test__add_note", ...memory, ...roomRead,
    ]);
    expect(names({ github: true, privateOk: false, mcp: [conn("connected")] }).some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(names({ github: false, privateOk: true, mcp: [conn("needs_auth")] }).some((n) => n.startsWith("mcp__"))).toBe(false);
  });

  it("offers the read room tools only to a model that may see private content", () => {
    expect(names({ github: false, privateOk: false })).not.toContain("room_read");
    expect(names({ github: false, privateOk: true })).toContain("room_read");
  });

  it("finds a tool by name, the memory tools and a room's MCP tools included", () => {
    expect(findTool("github_comment", noMcp)?.write).toBe(true);
    expect(findTool("memory_save", noMcp)).toMatchObject({ kind: "memory", write: false });
    expect(findTool("room_search", noMcp)).toMatchObject({ kind: "room_read", write: false });
    expect(findTool("sandbox_run", noMcp)).toBeUndefined();
    expect(findTool("mcp__test__echo", noMcp)).toBeUndefined();
    const room = { roomId: "r1", mcp: [conn("needs_auth")] };
    expect(findTool("mcp__test__add_note", room)).toMatchObject({ kind: "mcp", write: true });
    expect(findTool("mcp__test__echo", room)?.check!({}, {} as never)).toBe("test needs reconnecting. An admin can reconnect it in the room panel.");
  });
});

describe("toolEnv in fake mode", () => {
  const room: ToolEnv["room"] = {
    roomId: "r1", threadId: "t1", threadNumber: 1, runId: "run1", agentId: "agent", agentName: "agent", kinds: [], delegates: "all", tainted: false, postCap: 10,
  };
  it("answers web search with two sources", async () => {
    const env = { ...await toolEnv("fake"), room };
    const result = await findTool("web_search", noMcp)!.run({ query: "q" }, env);
    expect(result.ok).toBe(true);
    expect(result.sources).toHaveLength(2);
  });

  it("runs the GitHub tools against the canned App, signed with its own key", async () => {
    const env = { ...await toolEnv("fake", github), room };
    const result = await findTool("github_read_file", noMcp)!.run({ path: "README.md" }, env);
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining("# Playground") });
  });

  it("signs an admin in with the canned GitHub, without the network", async () => {
    const { verifier, challenge } = pkce();
    const redirectUri = "http://localhost:3000/bff/github/callback";
    const code = new URL(fakeSignInPage({ clientId: "fake-client-id", redirectUri, state: "s", challenge })).searchParams.get("code")!;
    expect(await userInstallations(await toolEnv("fake"), code, verifier, redirectUri)).toEqual([{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }]);
  });

  it("fetches pages without the network, still refusing private addresses", async () => {
    const env = { ...await toolEnv("fake"), room };
    expect((await findTool("web_fetch", noMcp)!.run({ url: "https://example.com/" }, env)).output).toContain("Fake page");
    expect((await findTool("web_fetch", noMcp)!.run({ url: "http://169.254.169.254/" }, env)).ok).toBe(false);
  });
});
