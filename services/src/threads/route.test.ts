import { describe, it, expect, vi, beforeEach } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import { ValidationError } from "../lib/errors.js";
import { PICK_REFUSED } from "../models/privacy.js";
import { startOrSteer } from "../runs/start.js";
import { onlyTags, rewriteTags, routeSend, tagNames, tagNumbers } from "./route.js";

const chat = { admit: vi.fn(), send: vi.fn(), linkThread: vi.fn() };
const threads = { threadById: vi.fn(), threadByTag: vi.fn(), createThread: vi.fn() };
const agents = { list: vi.fn() };
vi.mock("../chat/repo.js", () => ({ chatRepo: () => chat }));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => threads }));
vi.mock("../agents/repo.js", () => ({ agentsRepo: () => agents }));
vi.mock("../runs/start.js", () => ({ startOrSteer: vi.fn() }));
vi.mock("../live/broadcast.js", () => ({ broadcastToRoom: vi.fn() }));

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

describe("onlyTags", () => {
  it.each(["#4", " #1 #2, ", "#4: ", "#general #4."])("is true for %j, which says where to go but nothing else", (text) =>
    expect(onlyTags(text)).toBe(true));
  it.each(["#4 please check", "#2: fix this", "#2's log", "`#4`", "see #4"])("is false for %j", (text) => expect(onlyTags(text)).toBe(false));
});

describe("tagNames", () => {
  it("lists each name tag once, lowercased, outside code", () => {
    expect(tagNames("#Deploy #deploy #3 `#hidden` #pr-check")).toEqual(["deploy", "pr-check"]);
  });
});

describe("tagNumbers", () => {
  it("lists each number tag once, in order, outside code and inline code", () => {
    expect(tagNumbers("#3 then #1, `#2` and #3 again\n```\n#4\n```\na#5 #6x #7")).toEqual([3, 1, 7]);
  });
});

describe("routeSend: thread tags in a people chat", () => {
  const me = { userId: "u1", username: "aman" };
  const byNumber = new Map([1, 2, 3, 4].map((n) => [n, { threadId: `t${n}`, number: n, taint: [] as string[] }]));
  const send = async (text: string) => {
    const { route } = await routeSend(me, { roomId: "r", chatId: "general", clientId: "k1", text });
    await route();
  };
  const copiedInto = () => chat.send.mock.calls.filter(([, , , o]) => o?.copy).map(([, i]) => i.chatId);

  beforeEach(() => {
    vi.clearAllMocks();
    let seq = 0;
    chat.admit.mockImplementation(async (_u, i: { text: string }) => ({ text: i.text, attachments: [] }));
    chat.send.mockImplementation(async (_u, i: { chatId: string }) => ({ roomId: "r", chatId: i.chatId, seq: ++seq }));
    threads.threadById.mockResolvedValue(null);
    threads.threadByTag.mockImplementation(async (_r, tag: { number?: number; name?: string }) =>
      (tag.name === "pr-check" ? byNumber.get(4) : byNumber.get(tag.number ?? 0)) ?? null);
    agents.list.mockResolvedValue([BUILT_IN]);
  });

  it("a tag anywhere in the text delivers the message into that thread and starts its run", async () => {
    await send("see #2 when you can");
    expect(copiedInto()).toEqual(["t2"]);
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t2", expect.objectContaining({ chatId: "t2", seq: 2 }), undefined);
    expect(chat.linkThread).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 1 }), { kind: "delivered", threads: [{ threadId: "t2", seq: 2 }] });
  });

  it("a leading tag still delivers, and a thread named by its #name is delivered as its #number", async () => {
    await send("#pr-check also docs");
    expect(chat.send).toHaveBeenCalledWith(me, expect.objectContaining({ chatId: "general", text: "#4 also docs" }), expect.anything());
    expect(copiedInto()).toEqual(["t4"]);
  });

  it("copies into each of the first three threads it tags, in order; a tag no thread has, or in code, routes nowhere", async () => {
    await send("#9 `#4` #2, #1 and #2 again, then #3 #4");
    expect(copiedInto()).toEqual(["t2", "t1", "t3"]);
    expect(vi.mocked(startOrSteer).mock.calls.map(([, , threadId]) => threadId)).toEqual(["t2", "t1", "t3"]);
    expect(chat.linkThread).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 1 }), {
      kind: "delivered", threads: [{ threadId: "t2", seq: 2 }, { threadId: "t1", seq: 3 }, { threadId: "t3", seq: 4 }],
    });
  });

  it("a thread tagged by name and by number gets one copy", async () => {
    await send("#pr-check and #4");
    expect(copiedInto()).toEqual(["t4"]);
  });

  it("a tagged thread takes the message rather than an agent it mentions", async () => {
    await send("@agent look at #1");
    expect(threads.createThread).not.toHaveBeenCalled();
    expect(copiedInto()).toEqual(["t1"]);
  });

  it("hands each thread the message as written; the brief tells its agent what a #tag is", async () => {
    await send("#2 #pr-check what changed?");
    expect(chat.send.mock.calls.filter(([, , , o]) => o?.copy).map(([, i]) => i.text)).toEqual(["#2 #4 what changed?", "#2 #4 what changed?"]);
  });

  it("refuses a message that is only thread tags, before storing anything", async () => {
    await expect(send("#2 #pr-check")).rejects.toThrow(new ValidationError("Add a message after the tag."));
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("delivers a file sent with only a tag", async () => {
    chat.admit.mockImplementation(async (_u, i: { text: string }) => ({ text: i.text, attachments: [{ key: "k", name: "a.png", size: 1, type: "image/png" }] }));
    await send("#2");
    expect(copiedInto()).toEqual(["t2"]);
  });

  it("a send with no thread tag delivers nothing", async () => {
    await send("over in #general, #99 and `#1`");
    expect(copiedInto()).toEqual([]);
    expect(chat.linkThread).not.toHaveBeenCalled();
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
    agents.list.mockResolvedValue([BUILT_IN]);
  });

  it("an unknown model is refused before the message is even admitted", async () => {
    await expect(send({ model: "gpt" })).rejects.toBeInstanceOf(ValidationError);
    expect(chat.admit).not.toHaveBeenCalled();
  });

  it("DeepSeek in a private thread is refused, and nothing is stored", async () => {
    await expect(send({ chatId: "t1", model: "deepseek-flash" })).rejects.toThrow(new ValidationError(PICK_REFUSED));
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("DeepSeek with a file delivered by tag, into any private thread tagged, or for @agent, is refused, and nothing is stored", async () => {
    threads.threadByTag.mockResolvedValue({ threadId: "t2", number: 2, taint: [] });
    await expect(send({ text: "#2 see this", attachments: [file], model: "deepseek-pro" })).rejects.toThrow(PICK_REFUSED);
    threads.threadByTag.mockImplementation(async (_r, tag: { number: number }) => (tag.number === 1 ? privateThread : { threadId: "t2", number: 2, taint: [] }));
    await expect(send({ text: "#2 and #1 see this", model: "deepseek-pro" })).rejects.toThrow(PICK_REFUSED);
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

describe("routeSend: agent mentions in a people chat", () => {
  const me = { userId: "u1", username: "aman" };
  const scout = { ...BUILT_IN, agentId: "a-scout", name: "scout", builtIn: false };
  const send = async (text: string) => {
    const { route } = await routeSend(me, { roomId: "r", chatId: "general", clientId: "k1", text });
    await route();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    chat.admit.mockImplementation(async (_u, i: { text: string }) => ({ text: i.text, attachments: [] }));
    chat.send.mockImplementation(async (_u, i: { chatId: string }) => ({ roomId: "r", chatId: i.chatId, seq: 1 }));
    threads.threadById.mockResolvedValue(null);
    threads.threadByTag.mockResolvedValue(null);
    threads.createThread.mockResolvedValue({ thread: { threadId: "t9" }, message: { seq: 1 } });
    agents.list.mockResolvedValue([BUILT_IN, scout]);
  });

  it("starts a thread with the agent the text mentions first", async () => {
    await send("hey @scout and @agent, look");
    expect(threads.createThread).toHaveBeenCalledWith(me, "r", expect.objectContaining({ agentId: "a-scout" }));
    expect(startOrSteer).toHaveBeenCalledWith(me, "r", "t9", { seq: 1 }, undefined);
    await send("@agent look");
    expect(threads.createThread).toHaveBeenLastCalledWith(me, "r", expect.objectContaining({ agentId: "agent" }));
  });

  it("starts nothing for a mention in code, in an email address or of a longer name", async () => {
    await send("run `@scout go`, mail a@scout.com, ask @scout-2");
    expect(threads.createThread).not.toHaveBeenCalled();
  });

  it("reads the room's agents only for a text with an @ in it", async () => {
    await send("just people here");
    expect(agents.list).not.toHaveBeenCalled();
  });
});
