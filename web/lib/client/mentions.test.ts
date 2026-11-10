import { describe, expect, it } from "vitest";
import { parseMentions } from "./mentions";

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
