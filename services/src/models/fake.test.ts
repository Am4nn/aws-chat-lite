import { describe, expect, it } from "vitest";
import { NAME_PROMPT, type ModelChunk, type ModelMessage, type ModelRequest } from "./gateway.js";
import { fakeModel } from "./fake.js";
import { gateway } from "./index.js";

const model = fakeModel({ sleep: async () => {} });
const request = (messages: ModelMessage[], over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "fake",
  system: "",
  messages,
  tools: [],
  ...over,
});
const user = (text: string): ModelMessage => ({ role: "user", author: "aman", text });
const toolResult = (n: number): ModelMessage => ({ role: "tool", toolCallId: `call-${n}`, output: "ok" });

async function collect(req: ModelRequest): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of model.stream(req)) chunks.push(chunk);
  return chunks;
}
const textOf = (chunks: ModelChunk[]) => chunks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
const toolCalls = (chunks: ModelChunk[]) => chunks.flatMap((c) => (c.type === "tool_call" ? [c.call] : []));

describe("fakeModel", () => {
  it("is deterministic", async () => {
    const req = request([user("summarise the open pull requests please")]);
    expect(await collect(req)).toEqual(await collect(req));
  });

  it("answers with a headline and the requested number of body words, usage last", async () => {
    const chunks = await collect(request([user("hi tools:0 words:5")]));
    const [headline, body] = textOf(chunks).split("\n\n");
    expect(headline).toBe('Fake answer for "hi".');
    expect(body.trim().split(" ")).toHaveLength(5);
    expect(body.endsWith(".")).toBe(true);
    expect(chunks.at(-1)?.type).toBe("usage");
    expect(toolCalls(chunks)).toHaveLength(0);
  });

  it("calls the tool until it has N results, and once more per steering message", async () => {
    const first = user("look tools:2");

    expect(toolCalls(await collect(request([first])))).toEqual([
      { id: "call-1", name: "fake.lookup", input: { query: "look", slow: false } },
    ]);

    const two = await collect(request([first, toolResult(1), toolResult(2)]));
    expect(toolCalls(two)).toHaveLength(0);
    expect(textOf(two)).toContain("Fake answer");

    const steered = await collect(request([first, toolResult(1), toolResult(2), user("also check x")]));
    expect(toolCalls(steered).map((c) => c.id)).toEqual(["call-3"]);
  });

  it("prices usage at 3 and 15 micro-dollars per token of ceil(chars / 4)", async () => {
    const chunks = await collect(request([user("x tools:0 words:1")], { system: "s".repeat(23) }));
    expect(textOf(chunks)).toHaveLength(26);
    expect(chunks.at(-1)).toEqual({ type: "usage", inputTokens: 10, outputTokens: 7, costMicros: 135 });
  });

  it("counts assistant and tool message text as input", async () => {
    const chunks = await collect(
      request([
        user("x tools:0 words:1"),
        { role: "assistant", text: "abcd", toolCalls: [{ id: "call-1", name: "fake.lookup", input: {} }] },
        { role: "tool", toolCallId: "call-1", output: "wxyz" },
      ]),
    );
    // 17 + 4 + 4 = 25 chars; dropping either the assistant or the tool text would give 21 chars, 6 tokens.
    expect(chunks.at(-1)).toMatchObject({ type: "usage", inputTokens: 7 });
  });

  it("counts the call JSON as output on a tool-call turn", async () => {
    const chunks = await collect(request([user("x tools:1")]));
    const [call] = toolCalls(chunks);
    expect(chunks.at(-1)).toMatchObject({ outputTokens: Math.ceil(JSON.stringify(call).length / 4) });
  });

  it("stops streaming text on abort but still reports usage", async () => {
    const controller = new AbortController();
    const chunks: ModelChunk[] = [];
    let texts = 0;
    for await (const chunk of model.stream(request([user("go tools:0 words:50")], { signal: controller.signal }))) {
      chunks.push(chunk);
      if (chunk.type === "text" && ++texts === 3) controller.abort();
    }
    expect(texts).toBe(3);
    expect(chunks.at(-1)?.type).toBe("usage");
  });

  it("throws on the fail directive", async () => {
    await expect(collect(request([user("boom fail")]))).rejects.toThrow("fake model failure");
  });

  it("waits longer per word with slow", async () => {
    const waits: number[] = [];
    const slowModel = fakeModel({ sleep: async (ms) => void waits.push(ms) });
    for await (const chunk of slowModel.stream(request([user("go tools:0 words:2 slow")]))) void chunk;
    expect(new Set(waits)).toEqual(new Set([150]));
  });

  it("names a thread from the first three words without mentions", async () => {
    const chunks = await collect(request([user("@agent Check PR 41 and 42")], { system: NAME_PROMPT }));
    expect(textOf(chunks)).toBe("check-pr-41");
  });
});

describe("gateway", () => {
  it("rejects an unknown gateway", () => {
    expect(() => gateway({ MODEL_GATEWAY: "openai" })).toThrow("Unknown model gateway");
  });

  it("returns the fake model", () => {
    expect(gateway({ MODEL_GATEWAY: "fake" })).toBeDefined();
  });
});
