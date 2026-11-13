import { describe, expect, it } from "vitest";
import { findDraftTags, onlyThreadTags, tagOptions, type RoomTags } from "./roomTags";

const tags: RoomTags = { roomId: "r1", threads: [{ number: 1, name: "help-clarify-request" }], chats: [{ chatId: "c1", name: "general" }] };

describe("onlyThreadTags", () => {
  it.each(["#help-clarify-request", "#1 ", "#1, #help-clarify-request:"])("is true for %j: it names a thread and says nothing", (text) =>
    expect(onlyThreadTags(text, tags)).toBe(true));
  it.each(["#1 please check", "#general", "#nothing", "`#1`", ""])("is false for %j", (text) => expect(onlyThreadTags(text, tags)).toBe(false));
});

describe("tagOptions", () => {
  const room: RoomTags = {
    roomId: "r1",
    threads: [{ number: 3, name: "pr-check" }, { number: 12, name: "deploy" }, { number: 14, name: "pr-review" }],
    chats: [{ chatId: "c1", name: "general" }, { chatId: "c2", name: "pr-chat" }],
  };
  it("lists the newest threads first, then the chats", () => {
    expect(tagOptions("", room).map((o) => o.name)).toEqual(["pr-review", "deploy", "pr-check", "general", "pr-chat"]);
  });
  it("narrows by the start of a name, ignoring case, or of a thread's number", () => {
    expect(tagOptions("PR", room)).toEqual([
      { name: "pr-review", kind: "thread", number: 14, tag: "pr-review" },
      { name: "pr-check", kind: "thread", number: 3, tag: "pr-check" },
      { name: "pr-chat", kind: "chat", tag: "pr-chat" },
    ]);
    expect(tagOptions("12", room)).toEqual([{ name: "deploy", kind: "thread", number: 12, tag: "deploy" }]);
  });
  it("tags a thread by number where its name wouldn't read as a name, and leaves out chats that can't be tagged", () => {
    const odd: RoomTags = {
      roomId: "r1",
      threads: [{ number: 4, name: "Q3 plan" }, { number: 5, name: "12" }],
      chats: [{ chatId: "c1", name: "my_chat" }, { chatId: "c2", name: "123" }, { chatId: "c3", name: "a".repeat(33) }],
    };
    expect(tagOptions("", odd).map((o) => [o.name, o.tag])).toEqual([["12", "5"], ["Q3 plan", "4"]]);
  });
});

describe("findDraftTags", () => {
  it("finds what a draft's tags will link to once sent: a thread by number or name, or a chat", () => {
    const text = "#1 #help-clarify-request #general #nothing #2 a#general";
    expect(findDraftTags(text, tags).map((t) => text.slice(t.start, t.end))).toEqual(["#1", "#help-clarify-request", "#general"]);
  });
});
