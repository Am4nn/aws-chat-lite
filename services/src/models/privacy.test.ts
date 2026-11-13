import { describe, expect, it } from "vitest";
import { modelIdOf } from "./picks.js";
import { isPrivate, mcpTaint, mergeTaint, messageTaint, PICK_REFUSED, pickRefusal, privateOf, RUN_REFUSED, runRefusal } from "./privacy.js";

describe("taint", () => {
  it("marks a message with an attachment", () => expect(messageTaint({ attachments: [{}] })).toEqual(["attachment"]));
  it("leaves other messages clean", () => {
    expect(messageTaint({ attachments: [] })).toEqual([]);
    expect(messageTaint({})).toEqual([]);
  });
  it("merges sorted and unique", () => {
    expect(mergeTaint(["attachment"], [], ["attachment"])).toEqual(["attachment"]);
    expect(mergeTaint(["sandbox"], ["github"], ["attachment", "sandbox"])).toEqual(["attachment", "github", "sandbox"]);
  });
  it("records MCP output per server", () => {
    expect(mcpTaint("notes")).toBe("mcp:notes");
    expect(mergeTaint([mcpTaint("b")], [mcpTaint("a"), "github"])).toEqual(["github", "mcp:a", "mcp:b"]);
  });
});

describe("pickRefusal", () => {
  it("refuses DeepSeek on private content", () => {
    expect(pickRefusal("deepseek-flash", ["attachment"])).toBe(PICK_REFUSED);
    expect(pickRefusal("deepseek-flash", ["github"])).toBe(PICK_REFUSED);
    expect(PICK_REFUSED).toContain("GitHub data");
    expect(pickRefusal("deepseek-flash", ["mcp:notes"])).toBe(PICK_REFUSED);
  });
  it("allows everything else", () => {
    expect(pickRefusal("sonnet", ["attachment"])).toBeNull();
    expect(pickRefusal("deepseek-flash", [])).toBeNull();
    expect(pickRefusal("auto", ["attachment"])).toBeNull();
    expect(pickRefusal(undefined, ["attachment"])).toBeNull();
  });
});

describe("runRefusal", () => {
  it("fails a DeepSeek run that meets private content", () =>
    expect(runRefusal("deepseek-v4-pro", ["attachment"])).toEqual({ status: "failed", reason: RUN_REFUSED }));
  it("fails one that meets any server's MCP output", () =>
    expect(runRefusal("deepseek-v4-pro", ["mcp:notes"])).toEqual({ status: "failed", reason: RUN_REFUSED }));
  it("lets other models run", () => expect(runRefusal("claude-sonnet-5-5", ["attachment"])).toBeNull());
});

describe("copy", () => {
  it("is fixed", () => {
    expect(PICK_REFUSED).toBe("This has private content (attachments, GitHub data, MCP tool output, sandbox files), so DeepSeek is off here. Pick another model.");
    expect(RUN_REFUSED).toBe(
      "This thread now has private content (attachments, GitHub data, MCP tool output, sandbox files), so DeepSeek stopped. Send again with another model.",
    );
  });
});

describe("room taint", () => {
  it("doesn't count room chat as private: DeepSeek stays on", () => {
    expect(isPrivate(["room"])).toBe(false);
    expect(isPrivate(["room", "github"])).toBe(true);
    expect(privateOf(["github", "room"])).toEqual(["github"]);
    expect(pickRefusal("deepseek-flash", ["room"])).toBeNull();
    expect(runRefusal(modelIdOf("deepseek-flash"), ["room"])).toBeNull();
  });
});
