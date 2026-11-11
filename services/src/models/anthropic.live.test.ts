import { afterAll, describe, expect, it } from "vitest";
import { JOBS, priceMicros, ROUTER_MODEL } from "./catalog.js";
import type { ModelChunk, ModelMessage, ModelRequest, ToolCall } from "./gateway.js";
import { gateway } from "./index.js";
import { parseRoute, ROUTER_PROMPT, routerInput } from "./picks.js";

// Real calls cost real money: each run of this suite stops itself at $0.50.
const CAP_MICROS = 500_000;
// Opus and Fable cost the most, so they get only the tool round, which also proves a plain answer and its cost.
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "deepseek-flash", "deepseek-v4-pro"];
const EXPENSIVE = ["claude-opus-5-5", "claude-fable-5-2"];

const SYSTEM = "You are being tested. Answer in as few words as possible.";
const GET_NUMBER = { name: "get_number", description: "Returns the number of the day.", inputSchema: { type: "object", properties: {} } };

let spentMicros = 0;
const rows: string[] = [];
const live = gateway({ ...process.env, MODEL_GATEWAY: "live" });

type Usage = Extract<ModelChunk, { type: "usage" }>;

async function ask(label: string, req: Omit<ModelRequest, "maxTokens" | "effort">) {
  const full: ModelRequest = { ...req, maxTokens: 1024, effort: "low" };
  // The most this call could cost: a generous prompt and every output token.
  const worst = priceMicros(full.model, { inputTokens: 4000, outputTokens: full.maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  if (spentMicros + worst > CAP_MICROS) throw new Error(`Skipping ${label}: it could pass the $0.50 cap.`);

  let text = "";
  const calls: ToolCall[] = [];
  let usage: Usage | undefined;
  let end: Extract<ModelChunk, { type: "end" }> | undefined;
  // A stream that fails mid-answer still reports what it cost before rejecting, and that counts against the cap.
  try {
    for await (const chunk of live.stream(full)) {
      if (chunk.type === "text") text += chunk.text;
      else if (chunk.type === "tool_call") calls.push(chunk.call);
      else if (chunk.type === "usage") usage = chunk;
      else end = chunk;
    }
  } finally {
    if (usage) {
      spentMicros += usage.costMicros;
      rows.push(
        `${full.model} | ${label} | in ${usage.inputTokens}, out ${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheWriteTokens} | ${(usage.costMicros / 1e6).toFixed(6)} | total ${(spentMicros / 1e6).toFixed(6)}`,
      );
      console.log(rows.at(-1));
    }
  }
  if (spentMicros > CAP_MICROS) throw new Error(`Real-model spend passed $0.50 ($${spentMicros / 1e6}).`);
  return { text, calls, usage, end };
}

const user = (text: string): ModelMessage => ({ role: "user", author: "aman", text });

describe.skipIf(!process.env.REAL_MODELS)("real models", () => {
  afterAll(() => {
    console.log(`\n${rows.join("\n")}\nreal-model spend: $${(spentMicros / 1e6).toFixed(6)}`);
  });

  for (const model of MODELS) {
    it.skipIf(EXPENSIVE.includes(model))(`${model} answers a plain request and bills it`, async () => {
      const { text, usage } = await ask("ok", { model, system: SYSTEM, messages: [user("Reply with the word ok.")], tools: [] });
      expect(text.toLowerCase()).toContain("ok");
      expect(usage?.costMicros).toBeGreaterThan(0);
    });

    it(`${model} calls a tool and reads its result back`, async () => {
      const ask1 = [user("Call get_number, then tell me the number it returned.")];
      const first = await ask("tool call", { model, system: SYSTEM, messages: ask1, tools: [GET_NUMBER] });
      expect(first.end?.stop).toBe("tool_use");
      expect(first.calls.length).toBeGreaterThan(0);
      expect(first.usage?.costMicros).toBeGreaterThan(0);

      const replay: ModelMessage[] = [
        ...ask1,
        { role: "assistant", text: first.text, toolCalls: first.calls, native: first.end?.native },
        ...first.calls.map((c): ModelMessage => ({ role: "tool", toolCallId: c.id, output: "42" })),
      ];
      const second = await ask("tool result", { model, system: SYSTEM, messages: replay, tools: [GET_NUMBER] });
      expect(second.text).toContain("42");
    });
  }

  it("the router sends small talk to Haiku and real work to Sonnet", async () => {
    const route = async (text: string) => {
      const { text: reply } = await ask(`route "${text}"`, {
        model: ROUTER_MODEL, system: ROUTER_PROMPT, messages: [user(routerInput(text))], tools: [],
      });
      return parseRoute(reply);
    };
    expect(JOBS.route.effort).toBe("low");
    expect(await route("hi")).toBe("claude-haiku-5-5");
    expect(await route("Refactor the auth module and add tests for it")).toBe("claude-sonnet-5-5");
  });
});
