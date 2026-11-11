import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "../lib/errors.js";
import { PICK_REFUSED } from "../models/privacy.js";
import { startOrSteer } from "../runs/start.js";
import { mentionsAgent, rewriteTags, routeSend, tagNames } from "./route.js";

const chat = { admit: vi.fn(), send: vi.fn(), linkThread: vi.fn() };
const threads = { threadById: vi.fn(), threadByTag: vi.fn(), createThread: vi.fn() };
vi.mock("../chat/repo.js", () => ({ chatRepo: () => chat }));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => threads }));
vi.mock("../runs/start.js", () => ({ startOrSteer: vi.fn() }));
vi.mock("../live/broadcast.js", () => ({ broadcastToRoom: vi.fn() }));

describe("mentionsAgent", () => {
  it("is true for @agent in the text", () => {
    expect(mentionsAgent("hey @agent check")).toBe(true);
  });

  it("is false inside backticks and in an email address", () => {
    expect(mentionsAgent("run `@agent check`")).toBe(false);
    expect(mentionsAgent("mail a@agent.com")).toBe(false);
  });
});

describe("rewriteTags", () => {
  it("turns a thread's #name into its #number and leaves other tags alone", () => {
    expect(rewriteTags("see #pr-check and #general", (n) => (n === "pr-check" ? 4 : null))).toBe("see #4 and #general");
  });

  it("leaves code, numbers and words with a # inside untouched", () => {
    const resolve = () => 7;
    expect(rewriteTags("`#pr-check` #12 a#pr-check", resolve)).toBe("`#pr-check` #12 a#pr-check");
    expect(rewriteTags("#PR-Check, then #pr-check.", (n) => (n === "pr-check" ? 4 : null))).toBe("#4, then #4.");
  });
});

describe("tagNames", () => {
  it("lists each name tag once, lowercased, outside code", () => {
    expect(tagNames("#Deploy #deploy #3 `#hidden` #pr-check")).toEqual(["deploy", "pr-check"]);
  });
});

describe("routeSend: the model pick", () => {
  const me = { userId: "u1", username: "aman" };
  const file = { key: "k", name: "report.pdf", size: 1, type: "application/pdf" };
  const privateThread = { threadId: "t1", number: 1, taint: ["attachment"] };
  const send = (o: { chatId?: string; text?: string; attachments?: unknown[]; model?: unknown }) =>
    routeSend(me, { roomId: "r", chatId: o.chatId ?? "general", clientId: "k1", text: o.text ?? "hi", attachments: o.attachments, model: o.model });

  beforeEach(() => {
    vi.clearAllMocks();
    chat.admit.mockImplementation(async (_u, i: { text: string; attachments?: unknown[] }) => ({ text: i.text, attachments: i.attachments ?? [] }));
    chat.send.mockImplementation(async (_u, i: { chatId: string }) => ({ roomId: "r", chatId: i.chatId, seq: 1 }));
    threads.threadById.mockImplementation(async (_r, id: string) => (id === "t1" ? privateThread : null));
    threads.threadByTag.mockResolvedValue(null);
  });

  it("an unknown model is refused before the message is even admitted", async () => {
    await expect(send({ model: "gpt" })).rejects.toBeInstanceOf(ValidationError);
    expect(chat.admit).not.toHaveBeenCalled();
  });

  it("DeepSeek in a private thread is refused, and nothing is stored", async () => {
    await expect(send({ chatId: "t1", model: "deepseek-flash" })).rejects.toThrow(new ValidationError(PICK_REFUSED));
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("DeepSeek with a file delivered by tag, or for @agent, is refused, and nothing is stored", async () => {
    threads.threadByTag.mockResolvedValue({ threadId: "t2", number: 2, taint: [] });
    await expect(send({ text: "#2 see this", attachments: [file], model: "deepseek-pro" })).rejects.toThrow(PICK_REFUSED);
    threads.threadByTag.mockResolvedValue(null);
    await expect(send({ text: "@agent look", attachments: [file], model: "deepseek-pro" })).rejects.toThrow(PICK_REFUSED);
    expect(chat.send).not.toHaveBeenCalled();
    expect(threads.createThread).not.toHaveBeenCalled();
  });

  it("a file for people only is sent whatever the pick, since no model reads it", async () => {
    await send({ text: "for you all", attachments: [file], model: "deepseek-pro" });
    expect(chat.send).toHaveBeenCalledTimes(1);
  });

  it("a send with no pick, even in a private thread, is handed on without one, for the room default to resolve", async () => {
    const { route } = await send({ chatId: "t1" });
    await route();
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t1", expect.objectContaining({ seq: 1 }), undefined);
  });

  it("a file delivered by tag reaches the thread's run on the copy, which makes the thread private", async () => {
    chat.send.mockImplementation(async (_u, i: { chatId: string }, admitted?: { attachments: unknown[] }) =>
      ({ roomId: "r", chatId: i.chatId, seq: 1, attachments: admitted?.attachments ?? [] }));
    threads.threadByTag.mockResolvedValue({ threadId: "t2", number: 2, taint: [] });
    const { route } = await send({ text: "#2 see this", attachments: [file] });
    await route();
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t2", expect.objectContaining({ chatId: "t2", attachments: [file] }), undefined);
  });

  it("an allowed pick is handed to the run", async () => {
    const { route } = await send({ chatId: "t1", model: "sonnet" });
    await route();
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t1", expect.objectContaining({ seq: 1 }), "sonnet");
  });
});
