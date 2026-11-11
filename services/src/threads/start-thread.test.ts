import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "../lib/errors.js";
import { startOrSteer } from "../runs/start.js";
import { startThread } from "./start-thread.js";

const threads = { createThread: vi.fn(), threadById: vi.fn() };
vi.mock("./repo.js", () => ({ threadsRepo: () => threads }));
vi.mock("../runs/start.js", () => ({ startOrSteer: vi.fn() }));

const me = { userId: "u1", username: "aman" };

describe("startThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threads.createThread.mockResolvedValue({ thread: { threadId: "t1", status: "idle" }, message: { seq: 1 } });
    threads.threadById.mockResolvedValue({ threadId: "t1", status: "running" });
  });

  it("creates the thread, starts a run on its first message and answers the thread as it is now", async () => {
    const out = await startThread(me, "r", { text: "hi", clientId: "k1" });
    expect(threads.createThread).toHaveBeenCalledWith(me, "r", { text: "hi", clientId: "k1" });
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t1", { seq: 1 }, undefined);
    expect(out).toEqual({ thread: { threadId: "t1", status: "running" }, message: { seq: 1 } });
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
