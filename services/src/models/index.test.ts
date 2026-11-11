import { describe, expect, it } from "vitest";
import { priceMicros } from "./catalog.js";
import type { ModelChunk, ModelProvider, ModelRequest, ProviderChunk } from "./gateway.js";
import { gateway, liveProviders } from "./index.js";

const request = (model: string, text: string): ModelRequest => ({
  model,
  system: "s".repeat(23),
  messages: [{ role: "user", author: "aman", text }],
  tools: [],
  maxTokens: 1000,
});

async function collect<T>(chunks: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}
const usageOf = (chunks: ModelChunk[]) =>
  chunks.find((c): c is Extract<ModelChunk, { type: "usage" }> => c.type === "usage");

/** A provider that answers with fixed chunks and remembers what it was asked. */
function scripted(chunks: ProviderChunk[]) {
  const asked: ModelRequest[] = [];
  const provider: ModelProvider = {
    async *stream(req) {
      asked.push(req);
      yield* chunks;
    },
  };
  return { provider, asked };
}
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 };

describe("gateway", () => {
  it("bills the fake model at $3 / $15", async () => {
    const chunks = await collect(gateway({ MODEL_GATEWAY: "fake" }).stream(request("fake", "x tools:0 words:1")));
    // 40 input chars and 26 output chars: 10 tokens at 3 and 7 tokens at 15 micro-dollars.
    expect(usageOf(chunks)).toEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 135,
    });
    expect(chunks.at(-1)?.type).toBe("end");
  });

  it("bills a real model id served by the fake at that model's rates", async () => {
    const chunks = await collect(
      gateway({ MODEL_GATEWAY: "fake" }).stream(request("claude-sonnet-5-5", "x tools:0 words:30")),
    );
    const metered = usageOf(chunks)!;
    expect(metered.costMicros).toBe(priceMicros("claude-sonnet-5-5", metered));
  });

  it("sends a live model to its provider and meters what it reports", async () => {
    const anthropic = scripted([{ type: "text", text: "hi" }, { type: "usage", ...usage }, { type: "end", stop: "end_turn" }]);
    const deepseek = scripted([]);
    const live = gateway({ MODEL_GATEWAY: "live" }, { anthropic: anthropic.provider, deepseek: deepseek.provider });
    const req = request("claude-haiku-5-5", "hi");

    expect(await collect(live.stream(req))).toEqual([
      { type: "text", text: "hi" },
      { type: "usage", ...usage, costMicros: priceMicros("claude-haiku-5-5", usage) },
      { type: "end", stop: "end_turn" },
    ]);
    expect(anthropic.asked).toEqual([req]);
    expect(deepseek.asked).toEqual([]);

    await collect(live.stream(request("deepseek-flash", "hi")));
    expect(deepseek.asked.map((r) => r.model)).toEqual(["deepseek-flash"]);
  });

  it("serves the fake model itself when live", async () => {
    const chunks = await collect(gateway({ MODEL_GATEWAY: "live" }).stream(request("fake", "hi tools:0 words:1")));
    expect(usageOf(chunks)).toMatchObject({ costMicros: expect.any(Number) });
  });

  it("builds the live providers from the model keys, and says which key is missing", async () => {
    const live = gateway({ MODEL_GATEWAY: "live" });
    await expect(collect(live.stream(request("claude-haiku-5-5", "hi")))).rejects.toThrow(
      "Claude isn't set up here (no ANTHROPIC_API_KEY).",
    );
    await expect(collect(live.stream(request("deepseek-flash", "hi")))).rejects.toThrow(
      "DeepSeek isn't set up here (no DEEPSEEK_API_KEY).",
    );
  });

  it("says who serves each model", () => {
    expect(gateway({ MODEL_GATEWAY: "fake" }).servedBy("claude-opus-5-5")).toBe("fake");
    const live = gateway({ MODEL_GATEWAY: "live" });
    expect(live.servedBy("claude-haiku-5-5")).toBe("anthropic");
    expect(live.servedBy("deepseek-flash")).toBe("deepseek");
    expect(live.servedBy("fake")).toBe("fake");
  });

  it("rejects an unknown gateway", () => {
    expect(() => gateway({ MODEL_GATEWAY: "openai" })).toThrow("Unknown model gateway");
  });
});

describe("liveProviders", () => {
  it("refuses to stream a provider whose key is missing", async () => {
    await expect(collect(liveProviders({}).anthropic.stream(request("claude-haiku-5-5", "hi")))).rejects.toThrow(
      "Claude isn't set up here (no ANTHROPIC_API_KEY).",
    );
  });
});
