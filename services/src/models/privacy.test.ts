import { describe, expect, it } from "vitest";
import { mergeTaint, messageTaint, PICK_REFUSED, pickRefusal, RUN_REFUSED, runRefusal } from "./privacy.js";

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
});

describe("pickRefusal", () => {
  it("refuses DeepSeek on private content", () => {
    expect(pickRefusal("deepseek-flash", ["attachment"])).toBe(PICK_REFUSED);
    expect(pickRefusal("deepseek-flash", ["github"])).toBe(PICK_REFUSED);
    expect(PICK_REFUSED).toContain("GitHub data");
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
