import { describe, expect, it } from "vitest";
import { NAME_PROMPT, type ModelMessage, type ModelRequest, type ProviderChunk } from "./gateway.js";
import { fakeModel } from "./fake.js";
import { ROUTER_PROMPT } from "./picks.js";

const model = fakeModel({ sleep: async () => {} });
const request = (messages: ModelMessage[], over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "fake",
  system: "",
  messages,
  tools: [],
  maxTokens: 4096,
  ...over,
});
const user = (text: string): ModelMessage => ({ role: "user", author: "aman", text });
const toolResult = (n: number): ModelMessage => ({ role: "tool", toolCallId: `call-${n}`, output: "ok" });

async function collect(req: ModelRequest): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of model.stream(req)) chunks.push(chunk);
  return chunks;
}
const texts = (chunks: ProviderChunk[]) => chunks.flatMap((c) => (c.type === "text" ? [c.text] : []));
const textOf = (chunks: ProviderChunk[]) => texts(chunks).join("");
const toolCalls = (chunks: ProviderChunk[]) => chunks.flatMap((c) => (c.type === "tool_call" ? [c.call] : []));
const types = (chunks: ProviderChunk[]) => chunks.map((c) => c.type);

describe("fakeModel", () => {
  it("is deterministic", async () => {
    const req = request([user("summarise the open pull requests please")]);
    expect(await collect(req)).toEqual(await collect(req));
  });

  it("answers with a headline and the requested number of body words, then usage and end", async () => {
    const chunks = await collect(request([user("hi tools:0 words:5")]));
    const [headline, body] = textOf(chunks).split("\n\n");
    expect(headline).toBe('Fake answer for "hi".');
    expect(body.trim().split(" ")).toHaveLength(5);
    expect(body.endsWith(".")).toBe(true);
    expect(types(chunks).slice(-2)).toEqual(["usage", "end"]);
    expect(toolCalls(chunks)).toHaveLength(0);
  });

  it("ends an answer with end_turn and a tool turn with tool_use, carrying the native turn", async () => {
    const sonnet = { model: "claude-sonnet-5-5" };
    const tool = await collect(request([user("look tools:1")], sonnet));
    expect(tool.at(-1)).toEqual({
      type: "end",
      stop: "tool_use",
      native: { model: "claude-sonnet-5-5", content: { fake: true, calls: ["call-1"] } },
    });

    const answer = await collect(request([user("look tools:0 words:2")], sonnet));
    expect(answer.at(-1)).toEqual({
      type: "end",
      stop: "end_turn",
      native: { model: "claude-sonnet-5-5", content: { fake: true, calls: [] } },
    });
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

  it("counts ceil(chars / 4) tokens, with no cache tokens and no cost", async () => {
    const chunks = await collect(request([user("x tools:0 words:1")], { system: "s".repeat(23) }));
    expect(textOf(chunks)).toHaveLength(26);
    expect(chunks.at(-2)).toEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("counts assistant and tool message text as input", async () => {
    const chunks = await collect(
      request([
        user("x tools:0 words:1"),
        { role: "assistant", text: "abcd" },
        { role: "tool", toolCallId: "call-1", output: "wxyz" },
      ]),
    );
    // 17 + 4 + 4 = 25 chars; dropping either the assistant or the tool text would give 21 chars, 6 tokens.
    expect(chunks.at(-2)).toMatchObject({ type: "usage", inputTokens: 7 });
  });

  it("counts an assistant message's tool calls as input", async () => {
    const calls = [{ id: "call-1", name: "fake.lookup", input: { query: "q" } }];
    const without = await collect(request([user("x tools:0 words:1"), { role: "assistant", text: "" }]));
    const withCalls = await collect(request([user("x tools:0 words:1"), { role: "assistant", text: "", toolCalls: calls }]));
    const tokens = (chunks: ProviderChunk[]) => (chunks.at(-2) as { inputTokens: number }).inputTokens;
    expect(tokens(withCalls) - tokens(without)).toBeGreaterThanOrEqual(Math.floor(JSON.stringify(calls).length / 4));
  });

  it("stops the answer at maxTokens, ending at the length limit", async () => {
    const chunks = await collect(request([user("go tools:0 words:400")], { maxTokens: 20 }));
    expect(textOf(chunks).length).toBeLessThanOrEqual(20 * 4 + 20);
    expect(chunks.at(-1)).toMatchObject({ type: "end", stop: "max_tokens" });
    expect((chunks.at(-2) as { outputTokens: number }).outputTokens).toBeLessThanOrEqual(25);
  });

  it("counts the call JSON as output on a tool-call turn", async () => {
    const chunks = await collect(request([user("x tools:1")]));
    const [call] = toolCalls(chunks);
    expect(chunks.at(-2)).toMatchObject({ outputTokens: Math.ceil(JSON.stringify(call).length / 4) });
  });

  it("stops streaming text on abort, then reports usage and an aborted end with no native turn", async () => {
    const controller = new AbortController();
    const chunks: ProviderChunk[] = [];
    let count = 0;
    for await (const chunk of model.stream(request([user("go tools:0 words:50")], { signal: controller.signal }))) {
      chunks.push(chunk);
      if (chunk.type === "text" && ++count === 3) controller.abort();
    }
    expect(texts(chunks)).toHaveLength(3);
    expect(chunks.at(-2)?.type).toBe("usage");
    expect(chunks.at(-1)).toEqual({ type: "end", stop: "aborted" });
  });

  it("throws on the fail directive", async () => {
    await expect(collect(request([user("boom fail")]))).rejects.toThrow("fake model failure");
  });

  it("drops the connection after N answer words with drop:N", async () => {
    const chunks: ProviderChunk[] = [];
    const drop = async () => {
      for await (const chunk of model.stream(request([user("go tools:0 drop:3 words:10")]))) chunks.push(chunk);
    };
    await expect(drop()).rejects.toThrow("fake connection dropped");
    const [headline, ...words] = texts(chunks);
    expect(headline).toBe('Fake answer for "go".\n\n');
    expect(words).toHaveLength(3);
  });

  it("cuts off a tool call at the length limit with cutoff", async () => {
    const chunks = await collect(request([user("look cutoff")]));
    expect(types(chunks)).toEqual(["tool_call", "usage", "end"]);
    expect(toolCalls(chunks)[0].input).toMatchObject({ query: "look" });
    expect(chunks.at(-1)).toMatchObject({ type: "end", stop: "max_tokens" });
  });

  it("declines with no text with refuse", async () => {
    const chunks = await collect(request([user("hmm refuse")]));
    expect(types(chunks)).toEqual(["usage", "end"]);
    expect(chunks.at(-1)).toMatchObject({ type: "end", stop: "refusal" });
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
    expect(chunks.at(-1)).toMatchObject({ type: "end", stop: "end_turn" });
  });

  it("routes to the word after route:, else sonnet", async () => {
    const route = async (text: string) => textOf(await collect(request([user(text)], { system: ROUTER_PROMPT })));
    expect(await route("route:haiku hi")).toBe("haiku");
    expect(await route("go")).toBe("sonnet");
    expect(await route("route:opus x")).toBe("opus");
  });

  it("strips the new directives from the query", async () => {
    const chunks = await collect(request([user("look route:haiku cutoff")]));
    expect(toolCalls(chunks)[0].input).toMatchObject({ query: "look" });
  });
});
