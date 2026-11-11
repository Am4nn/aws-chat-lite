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
  maxTokens: 1000,
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
        { role: "assistant", text: "abcd", toolCalls: [{ id: "call-1", name: "fake.lookup", input: {} }] },
        { role: "tool", toolCallId: "call-1", output: "wxyz" },
      ]),
    );
    // 17 + 4 + 4 = 25 chars; dropping either the assistant or the tool text would give 21 chars, 6 tokens.
    expect(chunks.at(-2)).toMatchObject({ type: "usage", inputTokens: 7 });
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

  describe("call:<tool>", () => {
    const comment = {
      name: "github_comment",
      description: "Comment",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string" }, number: { type: "integer" }, body: { type: "string" } },
        required: ["number", "body"],
      },
    };
    const fetchSpec = {
      name: "web_fetch",
      description: "Fetch",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          files: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          kind: { type: "string", enum: ["issues", "pulls"] },
          draft: { type: "boolean" },
        },
        required: ["url", "files", "kind", "draft"],
      },
    };
    const tools = [comment, fetchSpec];

    it("calls the named tool once with sample input, then answers", async () => {
      const first = user("go call:github_comment");
      expect(toolCalls(await collect(request([first], { tools })))).toEqual([
        { id: "call-1", name: "github_comment", input: { number: 1, body: "fake" } },
      ]);
      const after = await collect(request([first, toolResult(1)], { tools }));
      expect(toolCalls(after)).toHaveLength(0);
      expect(textOf(after)).toContain('Fake answer for "go".');
    });

    it("calls several tools in order and fills each type", async () => {
      const first = user("go call:web_fetch call:github_comment");
      const one = toolCalls(await collect(request([first], { tools })));
      expect(one).toEqual([
        { id: "call-1", name: "web_fetch", input: { url: "https://example.com/", files: [{ path: "fake" }], kind: "issues", draft: false } },
      ]);
      expect(toolCalls(await collect(request([first, toolResult(1)], { tools })))[0].name).toBe("github_comment");
    });

    it("skips a tool the request doesn't offer", async () => {
      const chunks = await collect(request([user("go call:github_comment")]));
      expect(toolCalls(chunks)).toHaveLength(0);
      expect(textOf(chunks)).toContain('Fake answer for "go".');
    });
  });

  describe("sandbox spans", () => {
    const sandboxTool = { name: "sandbox_run", description: "", inputSchema: {} };
    const withSandbox = { tools: [sandboxTool] };

    it("turns each span into one sandbox_run call, in order, and then answers", async () => {
      const first = user("go sh`echo hi` py`print(1)` js`1+1`");
      expect(toolCalls(await collect(request([first], withSandbox)))).toEqual([
        { id: "call-1", name: "sandbox_run", input: { language: "shell", code: "echo hi" } },
      ]);
      expect(toolCalls(await collect(request([first, toolResult(1)], withSandbox)))[0]!.input).toEqual({ language: "python", code: "print(1)" });
      expect(toolCalls(await collect(request([first, toolResult(1), toolResult(2)], withSandbox)))[0]!.input)
        .toEqual({ language: "javascript", code: "1+1" });
      const done = await collect(request([first, toolResult(1), toolResult(2), toolResult(3)], withSandbox));
      expect(toolCalls(done)).toHaveLength(0);
      expect(textOf(done)).toMatch(/^Fake answer for "go"\./);
    });

    it("says there is no sandbox when it isn't offered, and calls no tool", async () => {
      const chunks = await collect(request([user("go sh`echo hi`")]));
      expect(toolCalls(chunks)).toHaveLength(0);
      expect(textOf(chunks).startsWith("(no sandbox here)")).toBe(true);
    });

    it("reads no directives inside a span", async () => {
      const chunks = await collect(request([user("go sh`echo fail tools:3`")], withSandbox));
      expect(toolCalls(chunks).map((c) => c.name)).toEqual(["sandbox_run"]);
    });

    it("runs the spans before any call:<tool>", async () => {
      const first = user("go sh`ls` call:web_search");
      const tools = [sandboxTool, { name: "web_search", description: "", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
      expect(toolCalls(await collect(request([first], { tools })))[0]!.name).toBe("sandbox_run");
      expect(toolCalls(await collect(request([first, toolResult(1)], { tools })))).toEqual([
        { id: "call-2", name: "web_search", input: { query: "fake" } },
      ]);
      expect(toolCalls(await collect(request([first, toolResult(1), toolResult(2)], { tools })))).toHaveLength(0);
    });
  });

  it("strips the new directives from the query", async () => {
    const chunks = await collect(request([user("look route:haiku cutoff")]));
    expect(toolCalls(chunks)[0].input).toMatchObject({ query: "look" });
  });
});
