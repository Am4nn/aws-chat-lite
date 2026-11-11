import { describe, it, expect } from "vitest";
import { mentionsAgent, rewriteTags, tagNames } from "./route.js";

describe("mentionsAgent", () => {
  it("is true for @agent in the text", () => {
    expect(mentionsAgent("hey @agent check")).toBe(true);
  });

  it("is false inside backticks and in an email address", () => {
    expect(mentionsAgent("run `@agent check`")).toBe(false);
    expect(mentionsAgent("mail a@agent.com")).toBe(false);
  });
});

describe("rewriteTags", () => {
  it("turns a thread's #name into its #number and leaves other tags alone", () => {
    expect(rewriteTags("see #pr-check and #general", (n) => (n === "pr-check" ? 4 : null))).toBe("see #4 and #general");
  });

  it("leaves code, numbers and words with a # inside untouched", () => {
    const resolve = () => 7;
    expect(rewriteTags("`#pr-check` #12 a#pr-check", resolve)).toBe("`#pr-check` #12 a#pr-check");
    expect(rewriteTags("#PR-Check, then #pr-check.", (n) => (n === "pr-check" ? 4 : null))).toBe("#4, then #4.");
  });
});

describe("tagNames", () => {
  it("lists each name tag once, lowercased, outside code", () => {
    expect(tagNames("#Deploy #deploy #3 `#hidden` #pr-check")).toEqual(["deploy", "pr-check"]);
  });
});
