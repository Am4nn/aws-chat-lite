import { describe, it, expect } from "vitest";
import { parseMentions } from "./mentions.js";

const alice = { userId: "u-alice", username: "alice" };
const bob = { userId: "u-bob", username: "bob" };
const carol = { userId: "u-carol", username: "carol" };
const members = [alice, bob, carol];

describe("parseMentions", () => {
  it("matches case-insensitively and ignores emails and code spans", () => {
    expect(parseMentions("hi @Alice and @bob, mail a@b.com `@carol`", members)).toEqual({
      mentions: ["u-alice", "u-bob"],
      everyone: false,
    });
  });
  it("ignores fenced code blocks", () =>
    expect(parseMentions("```\n@carol\n```\n@bob", members).mentions).toEqual(["u-bob"]));
  it("dedupes", () => expect(parseMentions("@bob @BOB @bob", members).mentions).toEqual(["u-bob"]));
  it("requires a word boundary after the name", () => expect(parseMentions("@bobby", members).mentions).toEqual([]));
  it("sets everyone", () => expect(parseMentions("@everyone", members)).toEqual({ mentions: [], everyone: true }));
});
