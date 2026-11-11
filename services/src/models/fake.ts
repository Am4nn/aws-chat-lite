import type { ModelMessage, ModelProvider, ModelRequest, ProviderChunk, StopReason, ToolCall } from "./gateway.js";
import { NAME_PROMPT } from "./gateway.js";
import { sleep as wait } from "../lib/sleep.js";
import type { Language } from "../sandbox/sandbox.js";
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
  text.replace(/\b(tools|words|drop):\d+|\b(route|call|ask):\S+|\b(slow|fail|cutoff|refuse|recall)\b/g, " ");
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

/** Each ask:<agent> in the prompt is one delegate call, to that agent. */
const ASK = /\s*\bask:(\S+)/g;
/** Each sh`…`, py`…` or js`…` span in the prompt is one sandbox_run call. */
const SPAN = /\b(sh|py|js)`([^`]*)`/g;
const SPAN_LANGUAGES: Record<string, Language> = { sh: "shell", py: "python", js: "javascript" };

const charsOf = (m: ModelMessage) => {
  if (m.role === "tool") return m.output.length;
  return m.text.length + (m.role === "assistant" && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);
};

export function fakeModel({ sleep = wait } = {}): ModelProvider {
  return { stream: (req) => run(req, sleep) };
}

async function* run(req: ModelRequest, sleep: (ms: number) => Promise<void>): AsyncGenerator<ProviderChunk> {
  const first = req.messages.find((m) => m.role === "user");
  const prompt = first?.text ?? "";
  const inputChars = req.system.length + req.messages.reduce((sum, m) => sum + charsOf(m), 0);
  let outputChars = 0;
  const calls: string[] = [];
  const usage = (): ProviderChunk => ({
    type: "usage",
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.ceil(outputChars / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const finish = (stop: StopReason): ProviderChunk[] => [
    usage(),
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

  const spans = [...prompt.matchAll(SPAN)].map(([, lang, code]) => ({ language: SPAN_LANGUAGES[lang!]!, code: code! }));
  const sandboxOffered = req.tools.some((t) => t.name === "sandbox_run");
  const sandboxCalls = sandboxOffered ? spans : [];
  // Directives are read outside the spans, so code that says "fail" or "slow" is only code.
  const asked = prompt.replace(SPAN, " ");

  if (/\bfail\b/.test(asked)) throw new Error("fake model failure");
  if (/\brefuse\b/.test(asked)) {
    yield* finish("refusal");
    return;
  }

  const slow = /\bslow\b/.test(asked);
  const cutoff = /\bcutoff\b/.test(asked);
  const query = firstWords(stripDirectives(asked), 6);
  const toolTarget = directive(asked, "tools", 0, 5) ?? (spans.length ? 0 : 2);
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
  const stop = cutoff ? "max_tokens" : "tool_use";

  // With a delegate tool, the asks are the only tool calls: each hands the prompt, less its asks, to its agent. A model
  // without one (a helper's) reads them as words, so the task it was handed runs as any prompt would.
  const asks = req.tools.some((t) => t.name === "delegate") ? [...asked.matchAll(ASK)].map(([, agent]) => agent!) : [];
  if (asks.length) {
    if (results < asks.length) {
      yield* toolTurn({ id, name: "delegate", input: { agent: asks[results], task: prompt.replace(ASK, "").trim() } }, "tool_use");
      return;
    }
  } else {
    if (results < sandboxCalls.length) {
      yield* toolTurn({ id, name: "sandbox_run", input: sandboxCalls[results]! }, stop);
      return;
    }
    // call:<tool> uses the request's real tools, one per turn in the order named, in place of the lookups.
    const named = [...asked.matchAll(/\bcall:(\S+)/g)];
    if (named.length) {
      const tool = named.flatMap(([, name]) => req.tools.filter((t) => t.name === name))[results - sandboxCalls.length];
      if (tool) {
        yield* toolTurn({ id, name: tool.name, input: sampleInput(tool.inputSchema) as Record<string, unknown> }, "tool_use");
        return;
      }
    } else if (cutoff || results < sandboxCalls.length + toolTarget + steers) {
      // A cut-off reply stops inside its tool call, so the call is there but the turn ends at the length limit.
      yield* toolTurn({ id, name: "fake.lookup", input: { query, slow } }, stop);
      return;
    }
  }

  if (/\brecall\b/.test(asked)) {
    const notes = req.system.split("\n").filter((line) => line.startsWith("- ["));
    yield* reply(notes.length ? notes.join("\n") : "Nothing in memory.");
    return;
  }

  const words = directive(asked, "words", 1, 400) ?? 48;
  const drop = directive(asked, "drop", 0, 400);
  const body = Array.from({ length: words }, (_, i) => BODY_WORDS[i % BODY_WORDS.length]);
  body[words - 1] += ".";
  const noSandbox = spans.length && !sandboxOffered ? "(no sandbox here) " : "";
  const pieces = [`${noSandbox}Fake answer for "${query}".\n\n`, ...body.map((w, i) => (i < words - 1 ? `${w} ` : w))];
  for (const text of drop === undefined ? pieces : pieces.slice(0, drop)) {
    if (outputChars / 4 >= req.maxTokens) {
      yield* finish("max_tokens");
      return;
    }
    await sleep(slow ? 150 : 15);
    if (req.signal?.aborted) {
      yield* finish("aborted");
      return;
    }
    outputChars += text.length;
    yield { type: "text", text };
  }
  if (drop !== undefined) {
    // As the real adapter does, a dropped stream reports what it has used before the error.
    yield usage();
    throw new Error("fake connection dropped");
  }
  yield* finish("end_turn");
}
