import { describe, it, expect, vi } from "vitest";
import { Forbidden, ValidationError } from "../../lib/errors.js";
import { SERVER_TOOLS, toolsForScopes, type ServerDeps } from "./tools.js";

const me = { userId: "u1", username: "aman" };
const NOW = Date.parse("2026-11-11T10:00:00Z");
const thread = (number: number, name: string, extra: object = {}) =>
  ({ threadId: `t${number}`, number, name, status: "idle", archived: false, ...extra });

function setup() {
  const calls: string[] = [];
  const view = {
    room: { roomId: "r1", name: "Dev" },
    chats: [{ chatId: "c1", name: "general", unread: 2 }, { chatId: "c2", name: "random", unread: 0, archived: true }],
    threads: [
      thread(12, "pr-check", { status: "running" }), thread(3, "thread-3", { archived: true }),
      ...Array.from({ length: 21 }, (_, i) => thread(20 + i, `t-${20 + i}`)),
    ],
  };
  const message = (seq: number, o: object = {}) => ({
    seq, authorName: "bea", createdAt: new Date(NOW + seq * 1000).toISOString(), text: `m${seq}`, attachments: [], ...o,
  });
  const deps = {
    rooms: {
      listMyRooms: vi.fn(async () => [{ roomId: "r1", name: "Dev", role: "owner", mentions: 0 }, { roomId: "r2", name: "Ops", role: "member", mentions: 1 }]),
      getRoomView: vi.fn(async () => view),
    },
    history: vi.fn(async () => ({
      messages: [message(4), message(5, { deleted: "self", text: "" }), message(6, { attachments: [{}, {}] })],
    })),
    send: vi.fn(async (_u: unknown, i: { chatId: string }) => {
      calls.push("send");
      return { message: { roomId: "r1", chatId: i.chatId, seq: 7 }, route: async () => { calls.push("route"); } };
    }),
    broadcast: vi.fn(async () => { calls.push("broadcast"); }),
    startThread: vi.fn(async () => ({ thread: { number: 41 }, message: { seq: 1 } })),
    siteUrl: "https://chat.example",
  };
  return { deps, calls, typed: deps as unknown as ServerDeps };
}

const tool = (name: string) => SERVER_TOOLS.find((t) => t.name === name)!;
const run = (name: string, input: Record<string, unknown>, deps: ServerDeps) => tool(name).run(me, input, deps);

describe("toolsForScopes", () => {
  it("gives a read-only token only the read tools", () => {
    expect(toolsForScopes(["rooms:read"]).map((t) => t.name)).toEqual(["list_rooms", "list_room", "read_messages"]);
  });

  it("gives both scopes all five tools, and only the read tools claim to be read-only", () => {
    const tools = toolsForScopes(["rooms:read", "rooms:write"]);
    expect(tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ["list_rooms", true], ["list_room", true], ["read_messages", true], ["post_message", false], ["start_thread", false],
    ]);
  });
});

describe("the tools", () => {
  it("list_rooms lists each room with your role and its id", async () => {
    const { typed } = setup();
    expect(await run("list_rooms", {}, typed)).toBe("Dev · owner · id r1\nOps · member · id r2");
  });

  it("list_rooms says so when you're in none", async () => {
    const { deps, typed } = setup();
    deps.rooms.listMyRooms.mockResolvedValueOnce([]);
    expect(await run("list_rooms", {}, typed)).toBe("You aren't in any rooms yet.");
  });

  it("list_room lists chats with unread counts, archived ones marked, and the newest 20 unarchived threads", async () => {
    const { deps, typed } = setup();
    const out = await run("list_room", { room: "dev" }, typed);
    expect(deps.rooms.getRoomView).toHaveBeenCalledWith("r1", "u1");
    const lines = out.split("\n");
    expect(lines.slice(0, 5)).toEqual(["Chats:", "#general (2 unread)", "#random (0 unread) · archived, read-only", "Threads:", "#40 t-40 · idle"]);
    expect(lines).toHaveLength(24);
    expect(lines.at(-1)).toBe("#21 t-21 · idle");
    expect(out).not.toContain("#3 ");
  });

  it("read_messages reads a thread by its number, 30 by default, as plain lines", async () => {
    const { deps, typed } = setup();
    const out = await run("read_messages", { room: "r1", chat: "#12" }, typed);
    expect(deps.history).toHaveBeenCalledWith(me, "r1", "t12", { limit: 30 });
    expect(out).toBe([
      "Dev · #pr-check",
      "[4] bea · 2026-11-11T10:00:04.000Z: m4",
      "[5] bea · 2026-11-11T10:00:05.000Z: (deleted)",
      "[6] bea · 2026-11-11T10:00:06.000Z: m6 [2 files]",
    ].join("\n"));
  });

  it("read_messages pages back with before, and refuses a limit over 100 or a bad before", async () => {
    const { deps, typed } = setup();
    await run("read_messages", { room: "r1", chat: "general", before: 40, limit: 5 }, typed);
    expect(deps.history).toHaveBeenCalledWith(me, "r1", "c1", { before: 40, limit: 5 });
    await expect(run("read_messages", { room: "r1", chat: "general", limit: 500 }, typed)).rejects.toBeInstanceOf(ValidationError);
    await expect(run("read_messages", { room: "r1", chat: "general", before: 1.5 }, typed)).rejects.toBeInstanceOf(ValidationError);
  });

  it("post_message sends as you, then broadcasts and routes before it answers", async () => {
    const { deps, calls, typed } = setup();
    const out = await run("post_message", { room: "Dev", chat: "#general", text: "deploy done" }, typed);
    expect(out).toBe("Posted to #general in Dev (message 7).");
    expect(deps.send).toHaveBeenCalledWith(me, { roomId: "r1", chatId: "c1", clientId: expect.stringMatching(/^mcp-/), text: "deploy done" });
    expect(deps.broadcast).toHaveBeenCalledWith("r1", { type: "message.new", message: { roomId: "r1", chatId: "c1", seq: 7 } });
    expect(calls).toEqual(["send", "broadcast", "route"]);
  });

  it("start_thread starts one on the room's default model and links to it", async () => {
    const { deps, typed } = setup();
    const out = await run("start_thread", { room: "Dev", text: "check the PR" }, typed);
    expect(deps.startThread).toHaveBeenCalledWith(me, "r1", { text: "check the PR", clientId: expect.stringMatching(/^mcp-/) });
    expect(out).toBe("Started #41 in Dev: https://chat.example/r/r1/t/41");
  });

  it("refuses missing text before anything is sent", async () => {
    const { deps, typed } = setup();
    await expect(run("post_message", { room: "Dev", chat: "general" }, typed)).rejects.toBeInstanceOf(ValidationError);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("passes a repo's refusal on as written, and hides anything else", async () => {
    const { deps, typed } = setup();
    deps.history.mockRejectedValueOnce(new Forbidden("You can't read this."));
    await expect(run("read_messages", { room: "Dev", chat: "general" }, typed)).rejects.toThrow(new Forbidden("You can't read this."));
    deps.history.mockRejectedValueOnce(new Error("ProvisionedThroughputExceeded"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run("read_messages", { room: "Dev", chat: "general" }, typed)).rejects.toThrow("Something went wrong.");
  });
});
