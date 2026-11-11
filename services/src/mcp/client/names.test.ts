import { describe, expect, it } from "vitest";
import { mcpServerOf, mcpToolName } from "./names.js";

describe("mcpToolName", () => {
  it("prefixes the server's name and keeps only characters a model's tool name may hold", () => {
    expect(mcpToolName("test", "add note!")).toBe("mcp__test__add_note_");
    expect(mcpToolName("my-server", "get-issue_2")).toBe("mcp__my-server__get-issue_2");
  });

  it("cuts a name over 64 characters and ends it with a hash of the tool's own name", () => {
    const long = "x".repeat(70);
    const name = mcpToolName("test", long);
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^mcp__test__x+_[0-9a-f]{8}$/);
    expect(mcpToolName("test", `${"x".repeat(69)}y`)).not.toBe(name);
  });

  it("names the server back from a tool name, a cut one included", () => {
    expect(mcpServerOf(mcpToolName("my-server", "add__note"))).toBe("my-server");
    expect(mcpServerOf(mcpToolName("test", "x".repeat(70)))).toBe("test");
  });
});
