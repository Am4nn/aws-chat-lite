import { describe, expect, it } from "vitest";
import { FAKE_TOOLS, mayRun, runTool, SANDBOX_TOOL, toolDetail, toolsFor } from "./tools.js";

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
    expect(toolDetail({ id: "call-1", name: "fake.lookup", input: { query: "prs", slow: false } })).toBe('Looking up "prs"');
    expect(toolDetail({ id: "call-2", name: "other", input: {} })).toBe("other");
  });

  it("shows a room tool's own line", () => {
    expect(toolDetail({ id: "c", name: "github_comment", input: { number: 4 } })).toBe("Commenting on #4");
    expect(toolDetail({ id: "c", name: "web_search", input: { query: "durable functions" } })).toBe("durable functions");
  });

  it("shows a sandbox run's language and its first line of code, cut at 60 characters", () => {
    const run = (code: string) => toolDetail({ id: "c", name: "sandbox_run", input: { language: "python", code } });
    expect(run("\nprint(1)\nprint(2)")).toBe("Running python: print(1)");
    expect(run("x".repeat(80))).toBe(`Running python: ${"x".repeat(60)}`);
  });
});

describe("toolsFor", () => {
  type Served = "anthropic" | "deepseek" | "fake";
  const names = (model: string, served: Served, connected = false) => toolsFor(model, served, connected).map((t) => t.name);
  const web = ["web_search", "web_fetch"];

  it("offers the sandbox only to models that may see private content, the fake tools only to the fake, and the web to all", () => {
    expect(names("deepseek-flash", "fake")).toEqual(["fake.lookup", ...web]);
    expect(names("deepseek-flash", "deepseek")).toEqual(web);
    expect(names("claude-sonnet-5-5", "anthropic")).toEqual(["sandbox_run", ...web]);
    expect(names("fake", "fake")).toEqual(["fake.lookup", "sandbox_run", ...web]);
  });

  it("offers GitHub only when the room is connected, and never to a model kept from private content", () => {
    expect(names("claude-sonnet-5-5", "anthropic", true).filter((n) => n.startsWith("github_"))).toHaveLength(9);
    expect(names("deepseek-flash", "deepseek", true)).toEqual(web);
  });

  it("lets a GitHub call run without a connection, so the tool itself says it isn't connected, but never for DeepSeek", () => {
    expect(mayRun("claude-sonnet-5-5", "anthropic", "github_read_file")).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "github_read_file")).toBe(false);
    expect(mayRun("deepseek-flash", "deepseek", "web_fetch")).toBe(true);
    expect(mayRun("deepseek-flash", "deepseek", "sandbox_run")).toBe(false);
    expect(mayRun("claude-sonnet-5-5", "anthropic", "fake.lookup")).toBe(false);
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
