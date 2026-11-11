import { describe, expect, it } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import { delegateResult, helperKinds, noSuchAgent } from "./helpers.js";

describe("delegateResult", () => {
  it("is the helper's whole answer when it finished", () => {
    expect(delegateResult("researcher", { status: "done" }, "Found 3 docs.\n\nDetails.")).toEqual({ ok: true, output: "Found 3 docs.\n\nDetails." });
  });

  it("cuts an answer past 20,000 characters, by code point, and says so", () => {
    const { output } = delegateResult("researcher", { status: "done" }, "😀".repeat(20_001));
    expect(output).toBe(`${"😀".repeat(20_000)}\n…(cut)`);
  });

  it("says why a helper that didn't finish has no answer", () => {
    expect(delegateResult("researcher", { status: "stopped", reason: "Stopped by bea." }, "Half")).toEqual({
      ok: false, output: "@researcher couldn't finish: Stopped by bea.",
    });
  });
});

it("an agent the room doesn't have is refused with the ones it does", () => {
  const scout = { ...BUILT_IN, agentId: "a1", name: "scout", builtIn: false };
  expect(noSuchAgent("nobody", [BUILT_IN, scout])).toBe("There's no @nobody in this room. Agents: @agent, @scout.");
});

describe("helperKinds", () => {
  it("keeps every kind for a helper whose answer goes to a model that may see private content", () => {
    expect(helperKinds(["github", "mcp", "sandbox", "web"], "claude-sonnet-5-5")).toEqual(["github", "mcp", "sandbox", "web"]);
  });

  it("keeps only the web for a helper working for DeepSeek, so its results never make the thread private", () => {
    expect(helperKinds(["github", "mcp", "sandbox", "web"], "deepseek-flash")).toEqual(["web"]);
  });
});
