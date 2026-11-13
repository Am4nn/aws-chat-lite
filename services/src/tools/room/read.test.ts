import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN } from "../../agents/model.js";
import type { Message } from "../../chat/model.js";
import { ValidationError } from "../../lib/errors.js";
import type { TaintSource } from "../../models/privacy.js";
import type { ThreadSummary } from "../../threads/types.js";
import type { ToolEnv } from "../types.js";
import { ROOM_READ_TOOLS } from "./read.js";

const thread = (number: number, name: string, taint: TaintSource[], over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  roomId: "R", threadId: `t${number}`, number, name, agentId: "a-rev", status: "done", rev: 1, steps: 2, costMicros: 0, taint,
  createdBy: "u1", lastActivityAt: `2026-11-1${number}T09:00:00.000Z`, archived: false, ...over,
});

const fake = vi.hoisted(() => ({
  added: [] as unknown[][],
  history: vi.fn(),
  search: vi.fn(),
  directory: {} as unknown,
}));
vi.mock("../../rooms/repo.js", () => ({ roomDirectory: async () => fake.directory }));
vi.mock("../../chat/repo.js", () => ({ chatRepo: () => ({ roomHistory: fake.history }) }));
vi.mock("../../chat/search.js", () => ({ searchMessages: fake.search }));
vi.mock("../../threads/repo.js", () => ({
  threadsRepo: () => ({ addTaint: async (...args: unknown[]) => void fake.added.push(args) }),
}));

const msg = (over: Partial<Message>): Message => ({
  roomId: "R", chatId: "c1", seq: 1, authorId: "u1", authorName: "aman", text: "hi", createdAt: "2026-11-13T10:00:00.000Z",
  attachments: [], reactions: {}, mentions: [], everyone: false, ...over,
});

const env = {
  room: {
    roomId: "R", threadId: "t7", threadNumber: 7, runId: "run7", agentId: "agent", agentName: "agent", kinds: ["room_read"],
    delegates: "all", tainted: false, postCap: 10,
  },
} as ToolEnv;

const tool = (name: string) => ROOM_READ_TOOLS.find((t) => t.spec.name === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  fake.added = [];
  fake.directory = {
    room: { roomId: "R", name: "Dev" },
    chats: [{ chatId: "c1", name: "general", lastSeq: 3, archived: false }, { chatId: "c2", name: "old", lastSeq: 1, archived: true }],
    threads: [
      thread(4, "pr-check", ["github", "room"]),
      thread(5, "notes", [], { agentId: "deleted", status: "idle", archived: true }),
      thread(6, "vendors", ["mcp:crm"]),
    ],
    agents: [BUILT_IN, { ...BUILT_IN, agentId: "a-rev", name: "reviewer", builtIn: false }],
    members: [{ userId: "u1", username: "aman", role: "owner" }, { userId: "u2", username: "bea", role: "member" }],
  };
});

describe("room read tools", () => {
  it("are room reads that write nothing and never ask", () => {
    expect(ROOM_READ_TOOLS.map((t) => t.spec.name)).toEqual(["room_list", "room_read", "room_search", "room_members"]);
    for (const t of ROOM_READ_TOOLS) expect([t.kind, t.write, t.ask]).toEqual(["room_read", false, undefined]);
  });

  it("lists chats and threads with numbers, agents and status, archived ones flagged", async () => {
    const out = (await tool("room_list").run({}, env)).output;
    expect(out).toContain("#general");
    expect(out).toContain("#old · archived");
    expect(out).toMatch(/#4 pr-check · @reviewer · done · /);
    expect(out).toContain("#5 notes · @agent · idle · 2026-11-15T09:00:00.000Z · archived");
    expect(out.indexOf("#6 vendors")).toBeLessThan(out.indexOf("#4 pr-check"));
  });

  it("reads a thread by #number or a chat by name, deleted messages blank, and never the thread's step logs", async () => {
    const answer = msg({
      chatId: "t4", seq: 2, authorId: "agent", authorName: "reviewer", text: "Looks good.",
      agent: { runId: "run4", status: "done", steps: 3, costMicros: 5, ms: 10, model: "claude-sonnet-5-5", pick: "sonnet", firstSeq: 1 },
    });
    fake.history.mockResolvedValue({ messages: [msg({ chatId: "t4", text: "", deleted: "self" }), answer] });
    expect(await tool("room_read").run({ chat: "#4", before: 9, limit: 5 }, env)).toEqual({
      ok: true,
      output: [
        "Dev · #pr-check",
        "[1] aman · 2026-11-13T10:00:00.000Z: (deleted)",
        "[2] reviewer · 2026-11-13T10:00:00.000Z: Looks good.",
      ].join("\n"),
    });
    expect(fake.history).toHaveBeenCalledWith("R", "t4", { before: 9, limit: 5 });

    fake.history.mockResolvedValue({ messages: [msg({})] });
    expect((await tool("room_read").run({ chat: "general" }, env)).output).toBe("Dev · #general\n[1] aman · 2026-11-13T10:00:00.000Z: hi");
    expect(fake.history).toHaveBeenLastCalledWith("R", "c1", { limit: 30 });
  });

  it("copies a private thread's taint into the reading thread, and never the room taint alone", async () => {
    fake.history.mockResolvedValue({ messages: [] });
    await tool("room_read").run({ chat: "#4" }, env);
    expect(fake.added).toEqual([["R", 7, ["github"]]]);

    fake.added = [];
    await tool("room_read").run({ chat: "#5" }, env);
    await tool("room_read").run({ chat: "general" }, env);
    expect(fake.added).toEqual([]);
  });

  it("copies the taint of every private thread a search result came from", async () => {
    fake.search.mockResolvedValue({
      results: [msg({ chatId: "t6", seq: 3, text: "renewal in March" }), msg({ chatId: "c1", text: "renewal?" }), msg({ chatId: "t4", text: "renewal PR" })],
    });
    const out = (await tool("room_search").run({ query: "renewal" }, env)).output;
    expect(out.split("\n")).toEqual([
      "#6 · [3] aman · 2026-11-13T10:00:00.000Z: renewal in March",
      "#general · [1] aman · 2026-11-13T10:00:00.000Z: renewal?",
      "#4 · [1] aman · 2026-11-13T10:00:00.000Z: renewal PR",
    ]);
    expect(fake.search).toHaveBeenCalledWith("R", "renewal");
    expect(fake.added).toEqual([["R", 7, ["github", "mcp:crm"]]]);
  });

  it("says so when a search finds nothing, and passes the search's own refusal on", async () => {
    fake.search.mockResolvedValue({ results: [] });
    expect(await tool("room_search").run({ query: "nothing" }, env)).toEqual({ ok: true, output: 'No messages match "nothing".' });
    fake.search.mockRejectedValue(new ValidationError("Search needs at least 2 characters."));
    expect(await tool("room_search").run({ query: "x" }, env)).toEqual({ ok: false, output: "Search needs at least 2 characters." });
    expect(fake.added).toEqual([]);
  });

  it("names an unknown chat and the tool that lists them", async () => {
    expect(await tool("room_read").run({ chat: "nope" }, env)).toEqual({ ok: false, output: 'No chat or thread "nope" in Dev. Try room_list.' });
    expect(fake.history).not.toHaveBeenCalled();
  });

  it("refuses a bad page size and lets any other failure throw, so the step is tried again", async () => {
    expect(await tool("room_read").run({ chat: "general", limit: 500 }, env)).toEqual({ ok: false, output: "limit must be a whole number from 1 to 100." });
    fake.history.mockRejectedValue(new Error("throttled"));
    await expect(tool("room_read").run({ chat: "general" }, env)).rejects.toThrow("throttled");
  });

  it("lists members with their roles, so the agent can @mention people", async () => {
    expect(await tool("room_members").run({}, env)).toEqual({ ok: true, output: "aman · owner\nbea · member" });
  });
});
