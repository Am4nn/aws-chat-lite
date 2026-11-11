import type { ModelMessage, ModelProvider, ModelRequest, ProviderChunk, StopReason, ToolCall } from "./gateway.js";
import { NAME_PROMPT } from "./gateway.js";
import { ROUTER_PROMPT } from "./picks.js";

const BODY_WORDS =
  "the agent checked every note and found that results looked steady across runs while costs stayed small and clear".split(
    " ",
  );

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const directive = (text: string, key: string, min: number, max: number) => {
  const match = text.match(new RegExp(`\\b${key}:(\\d+)`));
  return match ? clamp(Number(match[1]), min, max) : undefined;
};
const stripDirectives = (text: string) =>
  text.replace(/\b(tools|words|drop):\d+|\b(route|call):\S+|\b(slow|fail|cutoff|refuse)\b/g, " ");
const firstWords = (text: string, n: number) => text.split(/\s+/).filter(Boolean).slice(0, n).join(" ");

type Schema = { type?: string; format?: string; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; required?: string[] };

/** The smallest input a tool's JSON Schema accepts: its required properties only, each a fixed placeholder. */
function sampleInput(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return schema.format === "uri" ? "https://example.com/" : "fake";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [sampleInput(schema.items ?? {})];
    default:
      return Object.fromEntries((schema.required ?? []).map((key) => [key, sampleInput(schema.properties?.[key] ?? {})]));
  }
}

const charsOf = (m: ModelMessage) => (m.role === "tool" ? m.output.length : m.text.length);

export function fakeModel({ sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}): ModelProvider {
  return { stream: (req) => run(req, sleep) };
}

async function* run(req: ModelRequest, sleep: (ms: number) => Promise<void>): AsyncGenerator<ProviderChunk> {
  const first = req.messages.find((m) => m.role === "user");
  const prompt = first?.text ?? "";
  const inputChars = req.system.length + req.messages.reduce((sum, m) => sum + charsOf(m), 0);
  let outputChars = 0;
  const calls: string[] = [];
  const finish = (stop: StopReason): ProviderChunk[] => [
    {
      type: "usage",
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(outputChars / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    stop === "aborted" ? { type: "end", stop } : { type: "end", stop, native: { model: req.model, content: { fake: true, calls } } },
  ];
  const reply = (text: string): ProviderChunk[] => {
    outputChars += text.length;
    return [{ type: "text", text }, ...finish("end_turn")];
  };

  if (req.system === NAME_PROMPT) {
    const words = prompt.toLowerCase().replace(/@\S+/g, " ").match(/[a-z0-9]+/g) ?? [];
    yield* reply(words.slice(0, 3).join("-"));
    return;
  }
  if (req.system === ROUTER_PROMPT) {
    yield* reply(prompt.match(/\broute:(\S+)/)?.[1] ?? "sonnet");
    return;
  }

  if (/\bfail\b/.test(prompt)) throw new Error("fake model failure");
  if (/\brefuse\b/.test(prompt)) {
    yield* finish("refusal");
    return;
  }

  const slow = /\bslow\b/.test(prompt);
  const cutoff = /\bcutoff\b/.test(prompt);
  const query = firstWords(stripDirectives(prompt), 6);
  const toolTarget = directive(prompt, "tools", 0, 5) ?? 2;
  const firstToolIndex = req.messages.findIndex((m) => m.role === "tool");
  const results = req.messages.filter((m) => m.role === "tool").length;
  const steers =
    firstToolIndex < 0 ? 0 : req.messages.slice(firstToolIndex).filter((m) => m.role === "user").length;

  const toolTurn = (call: ToolCall, stop: StopReason): ProviderChunk[] => {
    calls.push(call.id);
    outputChars += JSON.stringify(call).length;
    return [{ type: "tool_call", call }, ...finish(stop)];
  };
  const id = `call-${results + 1}`;

  // call:<tool> uses the request's real tools, one per turn in the order named, in place of the lookups.
  const named = [...prompt.matchAll(/\bcall:(\S+)/g)];
  if (named.length) {
    const tool = named.flatMap(([, name]) => req.tools.filter((t) => t.name === name))[results];
    if (tool) {
      yield* toolTurn({ id, name: tool.name, input: sampleInput(tool.inputSchema) as Record<string, unknown> }, "tool_use");
      return;
    }
  } else if (cutoff || results < toolTarget + steers) {
    // A cut-off reply stops inside its tool call, so the call is there but the turn ends at the length limit.
    yield* toolTurn({ id, name: "fake.lookup", input: { query, slow } }, cutoff ? "max_tokens" : "tool_use");
    return;
  }

  const words = directive(prompt, "words", 1, 400) ?? 48;
  const drop = directive(prompt, "drop", 0, 400);
  const body = Array.from({ length: words }, (_, i) => BODY_WORDS[i % BODY_WORDS.length]);
  body[words - 1] += ".";
  const pieces = [`Fake answer for "${query}".\n\n`, ...body.map((w, i) => (i < words - 1 ? `${w} ` : w))];
  for (const text of drop === undefined ? pieces : pieces.slice(0, drop + 1)) {
    if (req.signal?.aborted) {
      yield* finish("aborted");
      return;
    }
    await sleep(slow ? 150 : 15);
    outputChars += text.length;
    yield { type: "text", text };
  }
  if (drop !== undefined) throw new Error("fake connection dropped");
  yield* finish("end_turn");
}
