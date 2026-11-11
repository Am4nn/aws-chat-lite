import { describe, expect, it } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import type { McpConnection, ToolKind } from "../threads/types.js";
import { delegateSpec, FAKE_TOOLS, mayRun, runTool, SANDBOX_TOOL, toolDetail, toolsFor } from "./tools.js";

const conn = (status: McpConnection["status"]): McpConnection => ({
  name: "test", url: "http://127.0.0.1:4710/mcp", auth: "oauth", status, toolCount: 1, toolsAt: "2026-11-11T00:00:00Z", addedBy: "aman",
  addedAt: "2026-11-11T00:00:00Z", tools: [{ name: "add_note", description: "Saves a note.", inputSchema: { type: "object" }, readOnly: false }],
});
const noMcp = { roomId: "r1", mcp: [] };
const ALL: ToolKind[] = ["sandbox", "web", "github", "mcp"];

const recorder = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe("runTool", () => {
  it("answers fake.lookup with three notes", async () => {
    const { waits, sleep } = recorder();
    const result = await runTool({ id: "call-1", name: "fake.lookup", input: { query: "prs" } }, { sleep });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith('Found 3 notes about "prs".')).toBe(true);
    expect(result.output.split("\n").filter((l) => l.startsWith("- note "))).toHaveLength(3);
    expect(waits).toEqual([200]);
  });

  it("takes longer when slow", async () => {
    const { waits, sleep } = recorder();
    await runTool({ id: "c", name: "fake.lookup", input: { query: "q", slow: true } }, { sleep });
    expect(waits).toEqual([1500]);
  });

  it("gives up when the run is stopped while the tool works", async () => {
    const { sleep } = recorder();
    const stop = new AbortController();
    stop.abort();
    expect(await runTool({ id: "c", name: "fake.lookup", input: { query: "q" } }, { sleep, signal: stop.signal })).toEqual({
      ok: false, output: "Stopped before the tool finished.",
    });
  });

  it("fails on an unknown tool", async () => {
    const { sleep } = recorder();
    expect(await runTool({ id: "c", name: "nope", input: {} }, { sleep })).toEqual({
      ok: false,
      output: "Unknown tool nope.",
    });
  });

  it("describes its tools", () => {
    expect(FAKE_TOOLS.map((t) => t.name)).toEqual(["fake.lookup"]);
  });
});

describe("toolDetail", () => {
  it("shows what a lookup is looking for", () => {
    expect(toolDetail({ id: "call-1", name: "fake.lookup", input: { query: "prs", slow: false } }, noMcp)).toBe('Looking up "prs"');
    expect(toolDetail({ id: "call-2", name: "other", input: {} }, noMcp)).toBe("other");
  });

  it("shows a room tool's own line", () => {
    expect(toolDetail({ id: "c", name: "github_comment", input: { number: 4 } }, noMcp)).toBe("Commenting on #4");
    expect(toolDetail({ id: "c", name: "web_search", input: { query: "durable functions" } }, noMcp)).toBe("durable functions");
    expect(toolDetail({ id: "c", name: "mcp__test__add_note", input: {} }, { roomId: "r1", mcp: [conn("connected")] })).toBe("test · add_note");
  });

  it("shows a sandbox run's language and its first line of code, cut at 60 characters", () => {
    const run = (code: string) => toolDetail({ id: "c", name: "sandbox_run", input: { language: "python", code } }, noMcp);
    expect(run("\nprint(1)\nprint(2)")).toBe("Running python: print(1)");
    expect(run("x".repeat(80))).toBe(`Running python: ${"x".repeat(60)}`);
  });
});

describe("toolsFor", () => {
  type Served = "anthropic" | "deepseek" | "fake";
  const names = (model: string, served: Served, connected = false, kinds = ALL) =>
    toolsFor(model, served, { ...noMcp, github: connected }, kinds).map((t) => t.name);
  const web = ["web_search", "web_fetch"];
  const memory = ["memory_save", "memory_update", "memory_forget"];

  it("offers the sandbox only to models that may see private content, the fake tools only to the fake, and the web to all", () => {
    expect(names("deepseek-flash", "fake")).toEqual(["fake.lookup", ...web, ...memory]);
    expect(names("deepseek-flash", "deepseek")).toEqual([...web, ...memory]);
    expect(names("claude-sonnet-5-5", "anthropic")).toEqual(["sandbox_run", ...web, ...memory]);
    expect(names("fake", "fake")).toEqual(["fake.lookup", "sandbox_run", ...web, ...memory]);
  });

  it("offers GitHub only when the room is connected, and never to a model kept from private content", () => {
    expect(names("claude-sonnet-5-5", "anthropic", true).filter((n) => n.startsWith("github_"))).toHaveLength(9);
    expect(names("deepseek-flash", "deepseek", true)).toEqual([...web, ...memory]);
  });

  it("lets a GitHub call run without a connection, so the tool itself says it isn't connected, but never for DeepSeek", () => {
    expect(mayRun("claude-sonnet-5-5", "anthropic", "github_read_file", noMcp, ALL)).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "github_read_file", noMcp, ALL)).toBe(false);
    expect(mayRun("deepseek-flash", "deepseek", "web_fetch", noMcp, ALL)).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "sandbox_run", noMcp, ALL)).toBe(false);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "fake.lookup", noMcp, ALL)).toBe(false);
  });

  it("offers a signed-in MCP server's tools to a model that may see private content, and never to DeepSeek", () => {
    const room = (status: McpConnection["status"]) => ({ roomId: "r1", github: false, mcp: [conn(status)] });
    expect(toolsFor("claude-sonnet-5-5", "anthropic", room("connected"), ALL).map((t) => t.name)).toContain("mcp__test__add_note");
    expect(toolsFor("deepseek-flash", "deepseek", room("connected"), ALL).map((t) => t.name)).toEqual([...web, ...memory]);
    expect(toolsFor("claude-sonnet-5-5", "anthropic", room("needs_auth"), ALL).some((t) => t.name.startsWith("mcp__"))).toBe(false);
  });

  it("lets a call to a server that needs reconnecting run, so its check says so, but not one the room no longer has", () => {
    expect(mayRun("claude-sonnet-5-5", "anthropic", "mcp__test__add_note", { roomId: "r1", mcp: [conn("needs_auth")] }, ALL)).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "mcp__test__add_note", { roomId: "r1", mcp: [conn("connected")] }, ALL)).toBe(false);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "mcp__test__add_note", noMcp, ALL)).toBe(false);
  });

  it("keeps only the kinds its agent may use, and the room memory always", () => {
    const webOnly = names("claude-sonnet-5-5", "anthropic", true, ["web"]);
    expect(webOnly).toEqual([...web, ...memory]);
    expect(names("claude-sonnet-5-5", "anthropic", true, [])).toEqual(memory);
    const room = { roomId: "r1", github: false, mcp: [conn("connected")] };
    expect(toolsFor("claude-sonnet-5-5", "anthropic", room, ["mcp"]).map((t) => t.name)).toEqual(["mcp__test__add_note", ...memory]);
  });

  it("never runs a call to a kind its agent may not use, even one the model names", () => {
    expect(mayRun("claude-sonnet-5-5", "anthropic", "sandbox_run", noMcp, ["web"])).toBe(false);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "github_comment", noMcp, ["web"])).toBe(false);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "web_search", noMcp, ["web"])).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "memory_save", noMcp, [])).toBe(true);
  });

  it("describes sandbox_run with its languages and a timeout of 1 to 300 seconds", () => {
    expect(SANDBOX_TOOL.inputSchema).toEqual({
      type: "object",
      properties: {
        language: { enum: ["shell", "python", "javascript"] },
        code: { type: "string" },
        timeoutSec: { type: "integer", minimum: 1, maximum: 300 },
      },
      required: ["language", "code"],
    });
  });
});

describe("delegateSpec", () => {
  const researcher = { ...BUILT_IN, agentId: "a1", name: "researcher", builtIn: false, instructions: `\n  Find sources.${"x".repeat(200)}\nCite them.` };

  it("isn't offered when the room has no other agent", () => {
    expect(delegateSpec([])).toBeUndefined();
  });

  it("names each agent it can hand to, by the first line of its instructions", () => {
    const spec = delegateSpec([BUILT_IN, researcher])!;
    expect(spec.name).toBe("delegate");
    expect(spec.inputSchema).toMatchObject({ properties: { agent: { enum: ["agent", "researcher"] }, task: { type: "string" } }, required: ["agent", "task"] });
    const roster = spec.description.split("\n").slice(-2);
    expect(roster).toEqual(["@agent", `@researcher: ${`Find sources.${"x".repeat(200)}`.slice(0, 120)}`]);
  });
});
