import { describe, expect, it } from "vitest";
import { mentionOptions, mentionQuery, outsideCode, parseMentions } from "./mentions";

const members = [{ userId: "u1", username: "alice" }, { userId: "u2", username: "bob" }];

describe("parseMentions", () => {
  it("matches members case-insensitively and dedupes", () => {
    expect(parseMentions("hi @Alice and @alice, @bob!", members)).toEqual({ mentions: ["u1", "u2"], everyone: false });
  });
  it("ignores strangers and emails", () => {
    expect(parseMentions("@stranger mail me at x@alice.com", members)).toEqual({ mentions: [], everyone: false });
  });
  it("needs a word boundary after the name", () => {
    expect(parseMentions("@alicex", members).mentions).toEqual([]);
  });
  it("ignores inline and fenced code", () => {
    expect(parseMentions("`@alice`\n```\n@bob\n```", members).mentions).toEqual([]);
  });
  it("sets everyone", () => {
    expect(parseMentions("@everyone look", members)).toEqual({ mentions: [], everyone: true });
  });
});

describe("mentionQuery", () => {
  it("finds the @word being typed at the caret", () => {
    expect(mentionQuery("hey @al")).toEqual({ start: 4, query: "al", trigger: "@" });
    expect(mentionQuery("@")).toEqual({ start: 0, query: "", trigger: "@" });
  });
  it("finds the #tag being typed the same way", () => {
    expect(mentionQuery("see #pr")).toEqual({ start: 4, query: "pr", trigger: "#" });
  });
  it("ignores emails, finished words and code spans", () => {
    expect(mentionQuery("mail x@al")).toBeNull();
    expect(mentionQuery("@alice ")).toBeNull();
    expect(mentionQuery("see `@al")).toBeNull();
    expect(mentionQuery("a#pr")).toBeNull();
    expect(mentionQuery("see `#pr")).toBeNull();
  });
});

describe("mentionOptions", () => {
  const agents = [{ name: "agent" }, { name: "reviewer" }];
  it("lists the room's agents first, then everyone, then people other than me", () => {
    expect(mentionOptions("", { agents, members, meId: "u2" })).toEqual([
      { name: "agent", kind: "agent" }, { name: "reviewer", kind: "agent" }, { name: "everyone", kind: "everyone" }, { name: "alice", kind: "member" },
    ]);
  });
  it("narrows by what was typed, ignoring case", () => {
    expect(mentionOptions("R", { agents, members, meId: "u2" })).toEqual([{ name: "reviewer", kind: "agent" }]);
  });
});

describe("outsideCode", () => {
  it("blanks code spans and fences, keeping every other character where it was", () => {
    expect(outsideCode("hi `@al` @bo")).toBe("hi       @bo");
    expect(outsideCode("```\n@bo\n``` @al")).toBe(`${" ".repeat(11)} @al`);
  });
});
