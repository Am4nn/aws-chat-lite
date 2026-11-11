import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { anthropicProvider, toMessages, toParams } from "./anthropic.js";
import type { ModelMessage, ModelRequest, ProviderChunk, ToolCall } from "./gateway.js";

const SONNET = "claude-sonnet-5-5";
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: SONNET,
  system: "be brief",
  messages: [{ role: "user", author: "aman", text: "hi" }],
  tools: [],
  maxTokens: 16_000,
  effort: "medium",
  cache: true,
  ...over,
});

describe("toParams", () => {
  it("sends a Claude run with its budget, effort and cache, and nothing the 5.5 models reject", () => {
    const params = toParams(request(), "anthropic");
    expect(params).toMatchObject({
      model: SONNET,
      max_tokens: 16_000,
      system: "be brief",
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
    });
    for (const key of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "tools"]) expect(params).not.toHaveProperty(key);
  });

  it("sends DeepSeek no effort and no cache marker", () => {
    const params = toParams(request({ model: "deepseek-flash" }), "deepseek");
    expect(params).not.toHaveProperty("output_config");
    expect(params).not.toHaveProperty("cache_control");
  });

  it("maps tools to the Anthropic shape", () => {
    const tools = [{ name: "get_number", description: "A number.", inputSchema: { type: "object", properties: {} } }];
    expect(toParams(request({ tools }), "anthropic").tools).toEqual([
      { name: "get_number", description: "A number.", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("refuses a tool name the API would reject", () => {
    const tools = [{ name: "fake.lookup", description: "", inputSchema: { type: "object" } }];
    expect(() => toParams(request({ tools }), "anthropic")).toThrow(
      "Tool names must match ^[a-zA-Z0-9_-]{1,64}$ (got fake.lookup)",
    );
  });
});

const c1: ToolCall = { id: "c1", name: "get_number", input: {} };
const c2: ToolCall = { id: "c2", name: "get_number", input: { n: 2 } };

describe("toMessages", () => {
  it("joins consecutive users into one turn, each text signed by its author", () => {
    const messages: ModelMessage[] = [
      { role: "user", author: "aman", text: "hi" },
      { role: "user", author: "bea", text: "and" },
    ];
    expect(toMessages(messages, SONNET, "anthropic")).toEqual([
      { role: "user", content: [{ type: "text", text: "aman: hi" }, { type: "text", text: "bea: and" }] },
    ]);
  });

  it("drops a leading assistant, a trailing assistant (a prefill) and an empty user text", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", text: "earlier" },
      { role: "user", author: "aman", text: "hi" },
      { role: "user", author: "bea", text: "  " },
      { role: "assistant", text: "partial" },
    ];
    expect(toMessages(messages, SONNET, "anthropic")).toEqual([{ role: "user", content: [{ type: "text", text: "aman: hi" }] }]);
  });

  it("replays the same model's own content verbatim, and rebuilds another model's turn from its calls", () => {
    const content = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "c1", name: "get_number", input: {} }];
    const turn = (model: string): ModelMessage[] => [
      { role: "user", author: "aman", text: "go" },
      { role: "assistant", text: "", toolCalls: [c1], native: { model, content } },
      { role: "tool", toolCallId: "c1", output: "42" },
    ];
    expect(toMessages(turn(SONNET), SONNET, "anthropic")[1]).toEqual({ role: "assistant", content });
    expect(toMessages(turn("claude-opus-5-5"), SONNET, "anthropic")[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "get_number", input: {} }],
    });
  });

  const round: ModelMessage[] = [
    { role: "user", author: "aman", text: "go" },
    { role: "assistant", text: "Checking.", toolCalls: [c1, c2] },
    { role: "tool", toolCallId: "c1", output: "42" },
    { role: "tool", toolCallId: "c2", output: "boom", isError: true },
    { role: "user", author: "bea", text: "also" },
  ];

  it("puts every tool result in the next user turn, before a steer's text", () => {
    const out = toMessages(round, SONNET, "anthropic");
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "c1", name: "get_number", input: {} },
        { type: "tool_use", id: "c2", name: "get_number", input: { n: 2 } },
      ],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "42", is_error: false },
        { type: "tool_result", tool_use_id: "c2", content: "boom", is_error: true },
        { type: "text", text: "bea: also" },
      ],
    });
  });

  it("keeps tool results first even when a steer was stored between them", () => {
    const [user, assistant, r1, r2, steer] = round;
    const out = toMessages([user!, assistant!, r1!, steer!, r2!], SONNET, "anthropic");
    expect((out[2]!.content as Anthropic.ContentBlockParam[]).map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
  });

  it("tells DeepSeek a tool failed in the result's text, since it ignores is_error", () => {
    const results = toMessages(round, "deepseek-flash", "deepseek")[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(results[0]!.content).toBe("42");
    expect(results[1]!.content).toBe("Tool error: boom");
  });
});

type Script = { events: Anthropic.RawMessageStreamEvent[]; final?: Partial<Anthropic.Message>; error?: Error };

/** Replays recorded stream events, like the SDK's MessageStream, and remembers what it was sent. */
function fakeClient(script: Script) {
  const sent: { params: Anthropic.MessageStreamParams; signal?: AbortSignal }[] = [];
  const client = {
    messages: {
      stream(params: Anthropic.MessageStreamParams, options: { signal?: AbortSignal }) {
        sent.push({ params, signal: options.signal });
        return {
          async *[Symbol.asyncIterator]() {
            yield* script.events;
            if (script.error) throw script.error;
          },
          finalMessage: async () => {
            if (script.error) throw script.error;
            return script.final;
          },
        };
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, "messages">, sent };
}

const usage = (u: Partial<Anthropic.Usage>) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: null,
  cache_creation_input_tokens: null,
  ...u,
}) as Anthropic.Usage;
const started = (input: number): Anthropic.RawMessageStreamEvent =>
  ({ type: "message_start", message: { usage: usage({ input_tokens: input, output_tokens: 1 }) } }) as Anthropic.RawMessageStreamEvent;
const delta = (text: string): Anthropic.RawMessageStreamEvent =>
  ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) as Anthropic.RawMessageStreamEvent;

async function run(script: Script, req = request()) {
  const fake = fakeClient(script);
  const chunks: ProviderChunk[] = [];
  let error: unknown;
  try {
    for await (const chunk of anthropicProvider(fake.client, "anthropic").stream(req)) chunks.push(chunk);
  } catch (e) {
    error = e;
  }
  return { chunks, error, sent: fake.sent };
}

const toolUse = { type: "tool_use", id: "c1", name: "get_number", input: { n: 1 } };
const final = (over: Partial<Anthropic.Message> = {}): Partial<Anthropic.Message> => ({
  content: [{ type: "text", text: "Hello" }, toolUse] as Anthropic.ContentBlock[],
  stop_reason: "tool_use",
  usage: usage({ input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }),
  ...over,
});

describe("anthropicProvider", () => {
  it("streams text, then the tool calls, the usage and the native turn from the final message", async () => {
    const signal = new AbortController().signal;
    const { chunks, error, sent } = await run({ events: [started(12), delta("Hel"), delta("lo")], final: final() }, request({ signal }));
    expect(error).toBeUndefined();
    expect(sent[0]!.signal).toBe(signal);
    expect(sent[0]!.params.model).toBe(SONNET);
    expect(chunks).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "tool_call", call: { id: "c1", name: "get_number", input: { n: 1 } } },
      { type: "usage", inputTokens: 12, outputTokens: 34, cacheReadTokens: 5, cacheWriteTokens: 6 },
      { type: "end", stop: "tool_use", native: { model: SONNET, content: final().content } },
    ]);
  });

  it("reads missing cache counts as zero", async () => {
    const { chunks } = await run({ events: [], final: final({ usage: usage({ input_tokens: 3, output_tokens: 4 }) }) });
    expect(chunks.find((c) => c.type === "usage")).toEqual({
      type: "usage", inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("ends an unknown stop reason as end_turn", async () => {
    const { chunks } = await run({ events: [], final: final({ stop_reason: "pause_turn" }) });
    expect(chunks.at(-1)).toMatchObject({ type: "end", stop: "end_turn" });
  });

  it("bills an aborted stream its reported input and estimated output, then ends aborted", async () => {
    const { chunks, error } = await run({
      events: [started(20), delta("Hell"), delta("o wo")],
      error: new Anthropic.APIUserAbortError(),
    });
    expect(error).toBeUndefined();
    expect(chunks.slice(2)).toEqual([
      { type: "usage", inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { type: "end", stop: "aborted" },
    ]);
  });

  it("bills a dropped stream once, then rejects", async () => {
    const dropped = new Anthropic.APIConnectionError({ message: "socket hang up" });
    const { chunks, error } = await run({ events: [started(20), delta("Hel")], error: dropped });
    expect(error).toBe(dropped);
    expect(chunks).toEqual([
      { type: "text", text: "Hel" },
      { type: "usage", inputTokens: 20, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("bills nothing for a stream that failed before the provider reported its input", async () => {
    const refused = new Anthropic.APIConnectionError({ message: "refused" });
    const { chunks, error } = await run({ events: [], error: refused });
    expect(error).toBe(refused);
    expect(chunks).toEqual([]);
  });
});
