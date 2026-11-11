import { describe, it, expect } from "vitest";
import { UserError } from "../../lib/errors.js";
import { findChat, findRoom } from "./refs.js";

const room = (roomId: string, name: string) => ({ roomId, name, role: "member" as const, mentions: 0 });

describe("findRoom", () => {
  const rooms = [room("r1", "Dev"), room("r2", "dev"), room("r3", "Ops")];

  it("matches an id, or a name whatever its case", () => {
    expect(findRoom(rooms, "r2").roomId).toBe("r2");
    expect(findRoom(rooms, "OPS").roomId).toBe("r3");
  });

  it("asks for the id when several rooms share the name", () => {
    expect(() => findRoom(rooms, "dev")).toThrow(new UserError('Several rooms are called "dev": r1, r2. Use the id.'));
  });

  it("points to list_rooms when none matches", () => {
    expect(() => findRoom(rooms, "design")).toThrow(new UserError('No room "design" among your rooms. Try list_rooms.'));
  });
});

describe("findChat", () => {
  const view = {
    room: { name: "Dev" },
    chats: [{ chatId: "c1", name: "general" }, { chatId: "c2", name: "12" }],
    threads: [{ threadId: "t12", number: 12, name: "pr-check" }, { threadId: "t3", number: 3, name: "general" }],
  } as any;

  it("reads #<digits> as a thread number, even when a chat has that name", () => {
    expect(findChat(view, "#12")).toEqual({ chatId: "t12", name: "pr-check" });
  });

  it("prefers a chat's name to a thread's, with or without #, then takes an id", () => {
    expect(findChat(view, "#general")).toEqual({ chatId: "c1", name: "general" });
    expect(findChat(view, "PR-Check")).toEqual({ chatId: "t12", name: "pr-check" });
    expect(findChat(view, "t3")).toEqual({ chatId: "t3", name: "general" });
    expect(findChat(view, "12")).toEqual({ chatId: "c2", name: "12" });
  });

  it("points to list_room when none matches", () => {
    expect(() => findChat(view, "#9")).toThrow(new UserError('No chat or thread "#9" in Dev. Try list_room.'));
  });
});
