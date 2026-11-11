import { describe, it, expect, vi, beforeEach } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import { NotFound, ValidationError } from "../lib/errors.js";
import { startOrSteer } from "../runs/start.js";
import { startThread } from "./start-thread.js";

const threads = { createThread: vi.fn(), threadById: vi.fn() };
const chat = { admit: vi.fn() };
const agents = { byId: vi.fn(), list: vi.fn() };
vi.mock("./repo.js", () => ({ threadsRepo: () => threads }));
vi.mock("../chat/repo.js", () => ({ chatRepo: () => chat }));
vi.mock("../agents/repo.js", () => ({ agentsRepo: () => agents }));
vi.mock("../runs/start.js", () => ({ startOrSteer: vi.fn() }));

const me = { userId: "u1", username: "aman" };
const scout = { ...BUILT_IN, agentId: "a-scout", name: "scout", builtIn: false };
const admitted = (text: string) => ({ text, attachments: [] });

describe("startThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.admit.mockImplementation(async (_u, i: { text: string }) => admitted(i.text));
    agents.list.mockResolvedValue([BUILT_IN, scout]);
    agents.byId.mockImplementation(async (_r, id: string) => ({ "a-scout": scout, "a-gone": { ...scout, deleted: true } })[id] ?? null);
    threads.createThread.mockResolvedValue({ thread: { threadId: "t1", status: "idle" }, message: { seq: 1 } });
    threads.threadById.mockResolvedValue({ threadId: "t1", status: "running" });
  });

  it("creates the thread for @agent, starts a run on its first message and answers the thread as it is now", async () => {
    const out = await startThread(me, "r", { text: "hi", clientId: "k1" });
    expect(threads.createThread).toHaveBeenCalledWith(me, "r", { text: "hi", clientId: "k1", admitted: admitted("hi"), agentId: "agent" });
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t1", { seq: 1 }, undefined);
    expect(out).toEqual({ thread: { threadId: "t1", status: "running" }, message: { seq: 1 } });
  });

  it("gives the thread the agent picked, else the first one the text mentions", async () => {
    await startThread(me, "r", { text: "hi @agent", clientId: "k1", agentId: "a-scout" });
    expect(threads.createThread).toHaveBeenLastCalledWith(me, "r", expect.objectContaining({ agentId: "a-scout" }));
    await startThread(me, "r", { text: "hi @scout", clientId: "k1" });
    expect(threads.createThread).toHaveBeenLastCalledWith(me, "r", expect.objectContaining({ agentId: "a-scout" }));
  });

  it("refuses an agent the room doesn't have, or no longer has, before any thread is made", async () => {
    await expect(startThread(me, "r", { text: "hi", clientId: "k1", agentId: "x" })).rejects.toThrow(new NotFound("No such agent."));
    await expect(startThread(me, "r", { text: "hi", clientId: "k1", agentId: "a-gone" })).rejects.toThrow(new NotFound("No such agent."));
    await expect(startThread(me, "r", { text: "hi", clientId: "k1", agentId: 7 })).rejects.toThrow(new NotFound("No such agent."));
    expect(threads.createThread).not.toHaveBeenCalled();
  });

  it("checks the message, and so the membership, before it looks up the agent", async () => {
    chat.admit.mockRejectedValueOnce(new Error("not a member"));
    await expect(startThread(me, "r", { text: "hi", clientId: "k1", agentId: "x" })).rejects.toThrow("not a member");
    expect(agents.byId).not.toHaveBeenCalled();
  });

  it("hands the run its model pick; DeepSeek is fine for text alone", async () => {
    await startThread(me, "r", { text: "hi", clientId: "k1", model: "deepseek-pro" });
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t1", { seq: 1 }, "deepseek-pro");
  });

  it("refuses an unknown model or a blank first message before any thread is made", async () => {
    await expect(startThread(me, "r", { text: "hi", clientId: "k1", model: "gpt" })).rejects.toBeInstanceOf(ValidationError);
    await expect(startThread(me, "r", { text: "  ", clientId: "k1" })).rejects.toThrow(new ValidationError("A new thread needs a first message."));
    expect(threads.createThread).not.toHaveBeenCalled();
  });

  it("still answers the thread when its run fails to start, so a retry can't make a second one", async () => {
    vi.mocked(startOrSteer).mockRejectedValueOnce(new Error("throttled"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(startThread(me, "r", { text: "hi", clientId: "k1" })).resolves.toMatchObject({ thread: { threadId: "t1" }, message: { seq: 1 } });
  });
});
