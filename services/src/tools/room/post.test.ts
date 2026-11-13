import { beforeEach, describe, expect, it, vi } from "vitest";
import { Gone } from "../../lib/errors.js";
import type { RunEvent } from "../../threads/types.js";
import type { ToolEnv } from "../types.js";
import { postRefusal, postsMade, ROOM_POST } from "./post.js";

const fake = vi.hoisted(() => ({
  events: [] as unknown[],
  send: vi.fn(),
  broadcast: vi.fn(async () => {}),
  routeSend: vi.fn(),
}));
vi.mock("../../rooms/repo.js", () => ({
  roomDirectory: async () => ({
    room: { roomId: "R", name: "Dev" },
    chats: [{ chatId: "C1", name: "general", lastSeq: 7, archived: false }, { chatId: "C2", name: "old", lastSeq: 1, archived: true }],
    threads: [{ threadId: "T12", number: 12, name: "pr-check" }],
    agents: [{ agentId: "agent", name: "agent" }, { agentId: "a-rev", name: "reviewer" }],
    members: [{ userId: "u1", username: "aman", role: "owner" }, { userId: "u2", username: "bea", role: "member" }],
  }),
}));
vi.mock("../../runs/repo.js", () => ({ runsRepo: () => ({ allEvents: async () => fake.events }) }));
vi.mock("../../chat/repo.js", () => ({ chatRepo: () => ({ send: fake.send }) }));
vi.mock("../../live/broadcast.js", () => ({ broadcastToRoom: fake.broadcast }));
vi.mock("../../threads/route.js", async (actual) => ({ ...await actual<object>(), routeSend: fake.routeSend }));

const env = {
  room: {
    roomId: "R", threadId: "T", threadNumber: 7, runId: "run7", agentId: "a-scout", agentName: "scout", kinds: ["room_post"],
    delegates: "all", tainted: false, postCap: 10,
  },
} as ToolEnv;

const started = (step: number, name: string, lane?: number) =>
  ({ type: "step.started", step, call: { id: `c${step}`, name, input: {} }, detail: "", seq: step, at: "", ...(lane && { lane }) }) as RunEvent;
const finished = (step: number, ok: boolean, lane?: number) =>
  ({ type: "step.finished", step, output: "", ms: 1, ok, seq: step, at: "", ...(lane && { lane }) }) as RunEvent;

const room = { agents: [{ name: "agent" }, { name: "reviewer" }], threads: [{ number: 12, name: "pr-check" }] };

beforeEach(() => {
  vi.clearAllMocks();
  fake.events = [];
  fake.send.mockImplementation(async (user, input, admitted) => ({ ...input, ...admitted, seq: 8, authorId: user.userId, authorName: user.username }));
});

describe("postRefusal", () => {
  it("refuses a post that would reach an agent or a thread, or the whole room", () => {
    expect(postRefusal("hey @everyone", room)).toBe("Posts can't use @everyone.");
    expect(postRefusal("@reviewer can you look", room)).toBe("Posts can't mention agents (@reviewer). Hand work to an agent with delegate.");
    expect(postRefusal("see #12", room)).toBe("Posts can't tag threads (#12). Name the thread without the #.");
    expect(postRefusal("see #pr-check", room)).toBe("Posts can't tag threads (#pr-check). Name the thread without the #.");
  });

  it("lets people, chats and code through", () => {
    expect(postRefusal("@bea done, see #general and `@reviewer`", room)).toBeNull();
    expect(postRefusal("see #13", room)).toBeNull();
  });
});

describe("postsMade", () => {
  it("counts only posts that went out, in every lane", () => {
    expect(postsMade([
      started(1, "room_post"), finished(1, true), started(2, "room_post"), finished(2, false), started(3, "room_post", 1), finished(3, true, 1),
      started(4, "web_fetch"), finished(4, true),
    ])).toBe(2);
  });
});

describe("room_post", () => {
  it("is a room write of its own kind", () => {
    expect([ROOM_POST.spec.name, ROOM_POST.kind, ROOM_POST.write]).toEqual(["room_post", "room_post", true]);
  });

  it("refuses an empty or overlong post, then one past the room's cap, before anyone is asked", async () => {
    expect(await ROOM_POST.check!({ chat: "general", text: "  " }, env)).toBe("A post needs text.");
    expect(await ROOM_POST.check!({ chat: "general" }, env)).toBe("A post needs text.");
    expect(await ROOM_POST.check!({ chat: "general", text: "x".repeat(4001) }, env)).toBe("text must be at most 4000 characters");
    fake.events = Array.from({ length: 10 }, (_, i) => [started(i + 1, "room_post"), finished(i + 1, true)]).flat();
    expect(await ROOM_POST.check!({ chat: "general", text: "hi" }, env)).toBe("This run has made its 10 posts, the room's cap per run.");
    expect(await ROOM_POST.check!({ chat: "general", text: "hi" }, { ...env, room: { ...env.room, postCap: 11 } })).toBeNull();
  });

  it("refuses a thread, an unknown chat and an archived one", async () => {
    expect(await ROOM_POST.check!({ chat: "nope", text: "hi" }, env)).toBe("There's no chat #nope here. Chats: #general, #old.");
    expect(await ROOM_POST.check!({ chat: "old", text: "hi" }, env)).toBe("#old is archived.");
    expect(await ROOM_POST.check!({ chat: "pr-check", text: "hi" }, env)).toMatch(/^There's no chat #pr-check here/);
  });

  it("takes a chat by name with or without its #, and refuses a post that would route", async () => {
    expect(await ROOM_POST.check!({ chat: "#General", text: "hi" }, env)).toBeNull();
    expect(await ROOM_POST.check!({ chat: "general", text: "@reviewer look" }, env)).toMatch(/^Posts can't mention agents/);
  });

  it("posts as the agent, marked as an agent post from its thread, and never routes", async () => {
    const result = await ROOM_POST.run({ chat: "general", text: "Deploy done, @bea" }, env);
    expect(result).toEqual({ ok: true, output: "Posted in #general (message 8)." });
    expect(fake.send.mock.calls).toEqual([[
      { userId: "agent", username: "scout" },
      { roomId: "R", chatId: "C1", clientId: expect.stringMatching(/^agent-/), text: "Deploy done, @bea" },
      { text: "Deploy done, @bea", attachments: [] },
      { system: true, agentPost: { threadId: "T", number: 7 } },
    ]]);
    expect(fake.broadcast).toHaveBeenCalledWith("R", { type: "message.new", message: expect.objectContaining({ seq: 8, chatId: "C1" }) });
    expect(fake.routeSend).not.toHaveBeenCalled();
  });

  it("gives each post its own client id, so a tab keeps a run's posts apart", async () => {
    await ROOM_POST.run({ chat: "general", text: "one" }, env);
    await ROOM_POST.run({ chat: "general", text: "two" }, env);
    const [first, second] = fake.send.mock.calls.map((c) => c[1].clientId);
    expect(first).not.toBe(second);
  });

  it("tells the model when the chat was archived since the check", async () => {
    fake.send.mockRejectedValue(new Gone("This chat is archived."));
    expect(await ROOM_POST.run({ chat: "general", text: "hi" }, env)).toEqual({ ok: false, output: "This chat is archived." });
    expect(fake.broadcast).not.toHaveBeenCalled();
  });

  it("asks with the chat and the start of the text", () => {
    expect(ROOM_POST.ask!({ chat: "general", text: "x".repeat(100) }, env)).toBe(`Post in #general: "${"x".repeat(80)}"?`);
  });
});
