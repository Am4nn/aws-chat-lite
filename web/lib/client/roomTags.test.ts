import { describe, expect, it } from "vitest";
import { onlyThreadTags, type RoomTags } from "./roomTags";

const tags: RoomTags = { roomId: "r1", threads: [{ number: 1, name: "help-clarify-request" }], chats: [{ chatId: "c1", name: "general" }] };

describe("onlyThreadTags", () => {
  it.each(["#help-clarify-request", "#1 ", "#1, #help-clarify-request:"])("is true for %j: it names a thread and says nothing", (text) =>
    expect(onlyThreadTags(text, tags)).toBe(true));
  it.each(["#1 please check", "#general", "#nothing", "`#1`", ""])("is false for %j", (text) => expect(onlyThreadTags(text, tags)).toBe(false));
});
