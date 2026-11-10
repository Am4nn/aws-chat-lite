import { describe, expect, it } from "vitest";
import { FAKE_TOOLS, runTool } from "./tools.js";

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
