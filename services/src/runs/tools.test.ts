import { describe, expect, it } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import type { ToolSpec } from "../models/gateway.js";
import type { McpConnection, ToolKind } from "../threads/types.js";
import { findTool } from "../tools/index.js";
import { agentCard, asksFirst, delegateSpec, FAKE_TOOLS, IMAGE_GATE, mayRun, runFakeLookup, SANDBOX_GATE, SANDBOX_TOOL, toolDetail, toolsFor } from "./tools.js";

const conn = (status: McpConnection["status"]): McpConnection => ({
  name: "test", url: "http://127.0.0.1:4710/mcp", auth: "oauth", status, toolCount: 1, toolsAt: "2026-11-11T00:00:00Z", addedBy: "aman",
  addedAt: "2026-11-11T00:00:00Z", tools: [{ name: "add_note", description: "Saves a note.", inputSchema: { type: "object" }, readOnly: false }],
});
const noMcp = { roomId: "r1", mcp: [] };
const ALL: ToolKind[] = ["sandbox", "web", "github", "mcp", "images"];

const recorder = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe("runFakeLookup", () => {
  it("answers fake.lookup with three notes", async () => {
    const { waits, sleep } = recorder();
    const result = await runFakeLookup({ id: "call-1", name: "fake.lookup", input: { query: "prs" } }, { sleep });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith('Found 3 notes about "prs".')).toBe(true);
    expect(result.output.split("\n").filter((l) => l.startsWith("- note "))).toHaveLength(3);
    expect(waits).toEqual([200]);
  });

  it("takes longer when slow", async () => {
    const { waits, sleep } = recorder();
    await runFakeLookup({ id: "c", name: "fake.lookup", input: { query: "q", slow: true } }, { sleep });
    expect(waits).toEqual([1500]);
  });

  it("gives up when the run is stopped while the tool works", async () => {
    const { sleep } = recorder();
    const stop = new AbortController();
    stop.abort();
    expect(await runFakeLookup({ id: "c", name: "fake.lookup", input: { query: "q" } }, { sleep, signal: stop.signal })).toEqual({
      ok: false, output: "Stopped before the tool finished.",
    });
  });

  it("fails on an unknown tool", async () => {
    const { sleep } = recorder();
    expect(await runFakeLookup({ id: "c", name: "nope", input: {} }, { sleep })).toEqual({
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

  it("quotes the first 60 characters of an image prompt", () => {
    const draw = (prompt: string) => toolDetail({ id: "c", name: "image_generate", input: { prompt } }, noMcp);
    expect(draw("A red fox")).toBe("Drawing \"A red fox\"");
    expect(draw("y".repeat(80))).toBe(`Drawing "${"y".repeat(60)}"`);
  });
});

describe("toolsFor", () => {
  type Served = "anthropic" | "deepseek" | "fake";
  const names = (model: string, served: Served, connected = false, kinds = ALL) =>
    toolsFor(model, served, { ...noMcp, github: connected }, kinds).map((t) => t.name);
  const web = ["web_search", "web_fetch"];
  const memory = ["memory_save", "memory_update", "memory_forget"];
  const forAll = ["image_generate", ...web, ...memory];

  it("offers the sandbox only to models that may see private content, the fake tools only to the fake, and images and the web to all", () => {
    expect(names("deepseek-flash", "fake")).toEqual(["fake.lookup", ...forAll]);
    expect(names("deepseek-flash", "deepseek")).toEqual(forAll);
    expect(names("claude-sonnet-5-5", "anthropic")).toEqual(["sandbox_run", ...forAll]);
    expect(names("fake", "fake")).toEqual(["fake.lookup", "sandbox_run", ...forAll]);
  });

  it("offers GitHub only when the room is connected, and never to a model kept from private content", () => {
    expect(names("claude-sonnet-5-5", "anthropic", true).filter((n) => n.startsWith("github_"))).toHaveLength(9);
    expect(names("deepseek-flash", "deepseek", true)).toEqual(forAll);
  });

  it("lets a GitHub call run without a connection, so the tool itself says it isn't connected, but never for DeepSeek", () => {
    expect(mayRun("claude-sonnet-5-5", "anthropic", "github_read_file", noMcp, ALL)).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "github_read_file", noMcp, ALL)).toBe(false);
    expect(mayRun("deepseek-flash", "deepseek", "web_fetch", noMcp, ALL)).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "sandbox_run", noMcp, ALL)).toBe(false);
    expect(mayRun("deepseek-flash", "deepseek", "image_generate", noMcp, ALL)).toBe(true);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "fake.lookup", noMcp, ALL)).toBe(false);
  });

  it("offers a signed-in MCP server's tools to a model that may see private content, and never to DeepSeek", () => {
    const room = (status: McpConnection["status"]) => ({ roomId: "r1", github: false, mcp: [conn(status)] });
    expect(toolsFor("claude-sonnet-5-5", "anthropic", room("connected"), ALL).map((t) => t.name)).toContain("mcp__test__add_note");
    expect(toolsFor("deepseek-flash", "deepseek", room("connected"), ALL).map((t) => t.name)).toEqual(forAll);
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
    expect(names("deepseek-flash", "deepseek", false, ["images"])).toEqual(["image_generate", ...memory]);
    const room = { roomId: "r1", github: false, mcp: [conn("connected")] };
    expect(toolsFor("claude-sonnet-5-5", "anthropic", room, ["mcp"]).map((t) => t.name)).toEqual(["mcp__test__add_note", ...memory]);
  });

  it("never runs a call to a kind its agent may not use, even one the model names", () => {
    expect(mayRun("claude-sonnet-5-5", "anthropic", "sandbox_run", noMcp, ["web"])).toBe(false);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "github_comment", noMcp, ["web"])).toBe(false);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "web_search", noMcp, ["web"])).toBe(true);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "image_generate", noMcp, ["web"])).toBe(false);
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

  it("knows another agent by its id, its name and the first line of its instructions, so a run carries no full instructions", () => {
    expect(agentCard(researcher)).toEqual({ agentId: "a1", name: "researcher", about: `Find sources.${"x".repeat(200)}`.slice(0, 120) });
  });

  it("isn't offered when the room has no other agent", () => {
    expect(delegateSpec([])).toBeUndefined();
  });

  it("names each agent it can hand to, by the first line of its instructions", () => {
    const spec = delegateSpec([BUILT_IN, researcher].map(agentCard))!;
    expect(spec.name).toBe("delegate");
    expect(spec.inputSchema).toMatchObject({ properties: { agent: { enum: ["agent", "researcher"] }, task: { type: "string" } }, required: ["agent", "task"] });
    const roster = spec.description.split("\n").slice(-2);
    expect(roster).toEqual(["@agent: The room's generalist.", `@researcher: ${`Find sources.${"x".repeat(200)}`.slice(0, 120)}`]);
  });
});

describe("asksFirst", () => {
  const echo = { name: "echo", description: "Repeats the text.", inputSchema: { type: "object" }, readOnly: true };
  const room = { roomId: "r1", mcp: [{ ...conn("connected"), tools: [echo, conn("connected").tools[0]!] }, { ...conn("connected"), name: "other" }] };
  const tool = (name: string) => findTool(name, room)!;
  const roomTool = (name: string, kind: "room_post" | "room_agents") => ({ spec: { name } as ToolSpec, kind, write: true });
  const ask = { mode: "ask", sandboxInternet: false } as const;
  const auto = { ...ask, mode: "auto" } as const;
  const bypass = { ...ask, mode: "bypass" } as const;

  it("asks before every write in Ask, whatever the thread holds, room writes included", () => {
    expect(asksFirst(tool("mcp__test__add_note"), [], ask)).toBe(true);
    expect(asksFirst(tool("mcp__test__add_note"), ["mcp:test"], ask)).toBe(true);
    expect(asksFirst(tool("github_comment"), [], ask)).toBe(true);
    expect(asksFirst(roomTool("room_post", "room_post"), [], ask)).toBe(true);
  });

  it("lets a read-only MCP call go without asking on a clean thread, or one holding only that server's own output", () => {
    expect(asksFirst(tool("mcp__test__echo"), [], ask)).toBe(false);
    expect(asksFirst(tool("mcp__test__echo"), ["mcp:test"], ask)).toBe(false);
  });

  it.each([["github"], ["attachment"], ["sandbox"], ["mcp:other"]] as const)(
    "asks before a read-only MCP call once the thread holds %s, since its input leaves for the server", (source) => {
      expect(asksFirst(tool("mcp__test__echo"), [source], ask)).toBe(true);
      expect(asksFirst(tool("mcp__test__echo"), ["mcp:test", source], ask)).toBe(true);
    },
  );

  it("asks before a web call on any private thread, MCP output included; a GitHub read never asks", () => {
    expect(asksFirst(tool("web_fetch"), [], ask)).toBe(false);
    expect(asksFirst(tool("web_fetch"), ["attachment"], ask)).toBe(true);
    expect(asksFirst(tool("web_fetch"), ["mcp:test"], ask)).toBe(true);
    expect(asksFirst(tool("github_read_file"), ["attachment"], ask)).toBe(false);
  });

  it("asks before an image in a private thread, since its prompt goes to Gemini, which may not see private content", () => {
    expect(asksFirst(IMAGE_GATE, [], ask)).toBe(false);
    expect(asksFirst(IMAGE_GATE, ["attachment"], ask)).toBe(true);
    expect(IMAGE_GATE.ask({ prompt: "a cat on a mat" })).toBe('Send "a cat on a mat" to Gemini for an image?');
  });

  it("never asks before saving to memory: memory stays in the room", () => {
    expect(asksFirst(tool("memory_save"), ["attachment", "mcp:test"], ask)).toBe(false);
  });

  it("lets posts and agent setup run on their own in Auto, and nothing else", () => {
    expect(asksFirst(roomTool("room_post", "room_post"), [], auto)).toBe(false);
    expect(asksFirst(roomTool("agent_create", "room_agents"), [], auto)).toBe(false);
    expect(asksFirst(tool("github_comment"), [], auto)).toBe(true);
    expect(asksFirst(tool("web_fetch"), ["attachment"], auto)).toBe(true);
  });

  it("runs everything in Bypass but the floor", () => {
    expect(asksFirst(tool("github_comment"), [], bypass)).toBe(false);
    expect(asksFirst(tool("web_fetch"), ["github"], bypass)).toBe(false);
    expect(asksFirst({ ...tool("mcp__test__add_note"), destructive: false }, [], bypass)).toBe(false);
  });

  it("always asks before a destructive call, and before anything that leaves the room once the thread read room chat", () => {
    for (const rules of [ask, auto, bypass]) {
      expect(asksFirst(tool("mcp__test__add_note"), [], rules)).toBe(true);
      expect(asksFirst(tool("memory_forget"), [], rules)).toBe(true);
      for (const name of ["web_search", "web_fetch", "github_get", "github_comment", "mcp__test__echo"]) {
        expect(asksFirst(tool(name), ["room"], rules)).toBe(true);
      }
      expect(asksFirst(IMAGE_GATE, ["room"], rules)).toBe(true);
      expect(asksFirst(SANDBOX_GATE, ["room"], { ...rules, sandboxInternet: true })).toBe(true);
      expect(asksFirst(SANDBOX_GATE, ["room"], { ...rules, sandboxInternet: false })).toBe(false);
      expect(asksFirst(tool("memory_save"), ["room"], rules)).toBe(false);
    }
  });

  it("asks before sandbox code only for the floor: its file work stays in the room", () => {
    expect(asksFirst(SANDBOX_GATE, ["attachment"], { ...ask, sandboxInternet: true })).toBe(false);
    expect(SANDBOX_GATE.ask({ language: "python", code: "1" })).toBe("Run python in the sandbox with internet access?");
  });
});
