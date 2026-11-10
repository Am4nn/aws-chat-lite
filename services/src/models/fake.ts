import type { ModelChunk, ModelGateway, ModelMessage, ModelRequest } from "./gateway.js";
import { NAME_PROMPT } from "./gateway.js";

const BODY_WORDS =
  "the agent checked every note and found that results looked steady across runs while costs stayed small and clear".split(
    " ",
  );

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const directive = (text: string, key: string, fallback: number, min: number, max: number) => {
  const match = text.match(new RegExp(`\\b${key}:(\\d+)`));
  return match ? clamp(Number(match[1]), min, max) : fallback;
};
const stripDirectives = (text: string) => text.replace(/\b(tools|words):\d+|\b(slow|fail)\b/g, " ");
const firstWords = (text: string, n: number) => text.split(/\s+/).filter(Boolean).slice(0, n).join(" ");

const charsOf = (m: ModelMessage) => (m.role === "tool" ? m.output.length : m.text.length);

export function fakeModel({ sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}): ModelGateway {
  return { stream: (req) => run(req, sleep) };
}

async function* run(req: ModelRequest, sleep: (ms: number) => Promise<void>): AsyncGenerator<ModelChunk> {
  const first = req.messages.find((m) => m.role === "user");
  const prompt = first?.text ?? "";
  const inputChars = req.system.length + req.messages.reduce((sum, m) => sum + charsOf(m), 0);
  let outputChars = 0;
  const usage = (): ModelChunk => {
    const inputTokens = Math.ceil(inputChars / 4);
    const outputTokens = Math.ceil(outputChars / 4);
    return { type: "usage", inputTokens, outputTokens, costMicros: 3 * inputTokens + 15 * outputTokens };
  };

  if (req.system === NAME_PROMPT) {
    const words = prompt.toLowerCase().replace(/@\S+/g, " ").match(/[a-z0-9]+/g) ?? [];
    const text = words.slice(0, 3).join("-");
    outputChars += text.length;
    yield { type: "text", text };
    yield usage();
    return;
  }

  if (/\bfail\b/.test(prompt)) throw new Error("fake model failure");

  const slow = /\bslow\b/.test(prompt);
  const query = firstWords(stripDirectives(prompt), 6);
  const toolTarget = directive(prompt, "tools", 2, 0, 5);
  const firstToolIndex = req.messages.findIndex((m) => m.role === "tool");
  const results = req.messages.filter((m) => m.role === "tool").length;
  const steers =
    firstToolIndex < 0 ? 0 : req.messages.slice(firstToolIndex).filter((m) => m.role === "user").length;

  if (results < toolTarget + steers) {
    const call = { id: `call-${results + 1}`, name: "fake.lookup", input: { query, slow } };
    outputChars += JSON.stringify(call).length;
    yield { type: "tool_call", call };
    yield usage();
    return;
  }

  const words = directive(prompt, "words", 48, 1, 400);
  const body = Array.from({ length: words }, (_, i) => BODY_WORDS[i % BODY_WORDS.length]);
  body[words - 1] += ".";
  const pieces = [`Fake answer for "${query}".\n\n`, ...body.map((w, i) => (i < words - 1 ? `${w} ` : w))];
  for (const text of pieces) {
    if (req.signal?.aborted) break;
    await sleep(slow ? 150 : 15);
    outputChars += text.length;
    yield { type: "text", text };
  }
  yield usage();
}
