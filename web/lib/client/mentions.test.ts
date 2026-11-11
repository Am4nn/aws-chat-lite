import { describe, expect, it } from "vitest";
import { mentionQuery, parseMentions } from "./mentions";

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
    expect(mentionQuery("hey @al")).toEqual({ start: 4, query: "al" });
    expect(mentionQuery("@")).toEqual({ start: 0, query: "" });
  });
  it("ignores emails, finished words and code spans", () => {
    expect(mentionQuery("mail x@al")).toBeNull();
    expect(mentionQuery("@alice ")).toBeNull();
    expect(mentionQuery("see `@al")).toBeNull();
  });
});
