import { describe, expect, it } from "vitest";
import { searchPlace } from "./searchPlace";

const chats = [{ chatId: "c1", name: "general" }];
const threads = [{ threadId: "t9", number: 4, name: "pr-check" }];

describe("searchPlace (where a search hit lives)", () => {
  it("opens a people chat at the message", () => {
    expect(searchPlace("r1", "c1", 7, chats, threads)).toEqual({ kind: "chat", label: "general", href: "/r/r1/c/c1?m=7" });
  });
  it("opens an agent thread by its number, since its chat id is the thread's id", () => {
    expect(searchPlace("r1", "t9", 7, chats, threads)).toEqual({ kind: "thread", label: "#4 pr-check", href: "/r/r1/t/4" });
  });
});
