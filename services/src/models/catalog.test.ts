import { describe, expect, it } from "vitest";
import { JOBS, modelInfo, modelOptions, priceMicros, ROUTER_MODEL } from "./catalog.js";

const use = (inputTokens: number, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});
const M = 1_000_000;

describe("priceMicros", () => {
  it("prices input and output", () => expect(priceMicros("claude-sonnet-5-5", use(1000, 500))).toBe(7000));
  it("prices cache reads and writes", () =>
    expect(priceMicros("claude-sonnet-5-5", use(100, 0, 10_000, 2_000))).toBe(6200));
  it("switches Haiku to the long card above 100k prompt tokens", () => {
    expect(priceMicros("claude-haiku-5-5", use(100_000, 1000))).toBe(10_500);
    expect(priceMicros("claude-haiku-5-5", use(100_001, 1000))).toBe(52_501);
  });
  it("counts cache tokens toward the long-card threshold", () =>
    expect(priceMicros("claude-haiku-5-5", use(1, 0, 100_000))).toBe(5001));
  it("rounds up to a whole micro-dollar", () => expect(priceMicros("claude-haiku-5-5", use(1))).toBe(1));
  it("prices every other model", () => {
    expect(priceMicros("deepseek-flash", use(M, M))).toBe(1_500_000);
    expect(priceMicros("deepseek-v4-pro", use(M, M))).toBe(5_280_000);
    expect(priceMicros("claude-fable-5-2", use(M, M))).toBe(48_000_000);
    expect(priceMicros("claude-opus-5-5", use(M, M))).toBe(24_000_000);
    expect(priceMicros("fake", use(10, 5))).toBe(105);
  });
  it("rejects an unknown model", () => expect(() => priceMicros("gpt-5", use(1))).toThrow("Unknown model gpt-5"));

  // Anthropic's price cards, in USD per million tokens: input, output, cache read, 5-minute cache write. Priced on
  // 100,000 tokens, the most Haiku's base card covers.
  const K = 100_000;
  it.each([
    ["claude-sonnet-5-5", 2, 10, 0.1, 2.5],
    ["claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125],
    ["claude-opus-5-5", 4, 20, 0.2, 5],
    ["claude-fable-5-2", 8, 40, 0.2, 10],
  ])("bills %s at its published card", (id, input, output, cacheRead, cacheWrite) => {
    expect([use(K), use(0, K), use(0, 0, K), use(0, 0, 0, K)].map((u) => priceMicros(id, u))).toEqual(
      [input, output, cacheRead, cacheWrite].map((usd) => Math.round(usd * K)),
    );
  });
  it("bills Haiku 5.5 above 100k prompt tokens at its long card: $0.50 / $2.50, cache $0.05 / $0.625", () => {
    expect(priceMicros("claude-haiku-5-5", use(M, M, M, M))).toBe((0.5 + 2.5 + 0.05 + 0.625) * M);
  });
});

describe("modelOptions", () => {
  it("lists the picker in order", () =>
    expect(modelOptions("aws").map((o) => o.pick)).toEqual([
      "auto",
      "sonnet",
      "haiku",
      "opus",
      "fable",
      "deepseek-flash",
      "deepseek-pro",
    ]));
  it("adds Fake last on local only", () => expect(modelOptions("local").at(-1)?.pick).toBe("fake"));
  it("shows prices, with none for Auto", () => {
    const options = modelOptions("aws");
    expect(options.find((o) => o.pick === "sonnet")?.price).toBe("$2 / $10");
    expect(options[0]).toMatchObject({ price: "" });
    expect(options[0]).not.toHaveProperty("id");
  });
  it("shows two decimals unless the price is whole", () =>
    expect(modelOptions("aws").map((o) => o.price)).toEqual([
      "",
      "$2 / $10",
      "$0.10 / $0.50",
      "$4 / $20",
      "$8 / $40",
      "$0.30 / $1.20",
      "$1.32 / $3.96",
    ]));
  it("marks both DeepSeeks as not private", () =>
    expect(
      modelOptions("aws")
        .filter((o) => o.pick.startsWith("deepseek"))
        .map((o) => o.privateOk),
    ).toEqual([false, false]));
});

describe("jobs", () => {
  it("runs small jobs on Haiku", () => expect(ROUTER_MODEL).toBe("claude-haiku-5-5"));
  it("sizes each job", () => {
    expect(JOBS.run).toEqual({ maxTokens: 16_000, effort: "medium", cache: true });
    expect(JOBS.route).toEqual({ maxTokens: 1024, effort: "low", cache: false });
    expect(JOBS.name).toEqual({ maxTokens: 1024, effort: "low", cache: false });
  });
  it("knows its models", () => expect(modelInfo("fake").provider).toBe("fake"));
});
