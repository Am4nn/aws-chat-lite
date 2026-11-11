import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "./catalog.js";
import type { ModelMessage, ModelProvider, ModelRequest, ProviderChunk, StopReason } from "./gateway.js";

/** Claude itself, or DeepSeek through its Anthropic-compatible endpoint, which takes no effort or cache settings. */
type Kind = "anthropic" | "deepseek";
type Turn = { role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] };

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const STOPS: StopReason[] = ["end_turn", "tool_use", "max_tokens", "refusal"];

/**
 * Leaves `thinking`, sampling and `tool_choice` unset: the 5.5 models reject sampling parameters and forced tool
 * choice, and thinking stays adaptive because Opus 5.5 and Fable can't turn it off.
 */
export function toParams(req: ModelRequest, kind: Kind): Anthropic.MessageStreamParams {
  for (const tool of req.tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`Tool names must match ^[a-zA-Z0-9_-]{1,64}$ (got ${tool.name})`);
  }
  const claude = kind === "anthropic";
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: toMessages(req.messages, req.model, kind),
    ...(req.tools.length > 0 && {
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    }),
    ...(claude && req.effort && { output_config: { effort: req.effort } }),
    ...(claude && req.cache && { cache_control: { type: "ephemeral" as const } }),
  };
}

function toTurn(m: ModelMessage, model: string, kind: Kind): Turn {
  if (m.role === "user") {
    return { role: "user", content: m.text.trim() ? [{ type: "text", text: `${m.author}: ${m.text}` }] : [] };
  }
  if (m.role === "tool") {
    const content = m.isError && kind === "deepseek" ? `Tool error: ${m.output}` : m.output;
    return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content, is_error: m.isError ?? false }] };
  }
  // The same model gets its own turn back verbatim, thinking included; another model can't read that content.
  if (m.native?.model === model) return { role: "assistant", content: m.native.content as Anthropic.ContentBlockParam[] };
  return {
    role: "assistant",
    content: [
      ...(m.text.trim() ? [{ type: "text" as const, text: m.text }] : []),
      ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
    ],
  };
}

/**
 * The conversation as the Messages API accepts it: alternating roles, starting with a user and ending on one (the
 * newer models reject an assistant prefill), and every tool result at the head of the user turn after its call.
 */
export function toMessages(messages: ModelMessage[], model: string, kind: Kind): Anthropic.MessageParam[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const turn = toTurn(m, model, kind);
    if (!turn.content.length) continue;
    const last = turns.at(-1);
    if (last?.role === turn.role) last.content.push(...turn.content);
    else turns.push({ ...turn, content: [...turn.content] });
  }
  for (const turn of turns) {
    // A steer stored while tools ran would otherwise land between results, and the API wants results first.
    if (turn.role === "user") turn.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
  }
  while (turns[0]?.role === "assistant") turns.shift();
  if (turns.at(-1)?.role === "assistant") turns.pop();
  return turns;
}

const tokens = (u: Anthropic.Usage): TokenUsage => ({
  inputTokens: u.input_tokens,
  outputTokens: u.output_tokens,
  cacheReadTokens: u.cache_read_input_tokens ?? 0,
  cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
});

/**
 * One usage chunk per call. A finished call reports the provider's final count; a call that stops early (a user's
 * stop, or a dropped connection) still owes its input, which the provider reports up front, so it reports that
 * plus an estimate of the output streamed so far.
 */
export function anthropicProvider(client: Pick<Anthropic, "messages">, kind: Kind): ModelProvider {
  return {
    async *stream(req): AsyncGenerator<ProviderChunk> {
      const stream = client.messages.stream(toParams(req, kind), { signal: req.signal });
      let input: TokenUsage | undefined;
      let chars = 0;
      let final: Anthropic.Message;
      try {
        for await (const event of stream) {
          if (event.type === "message_start") input = tokens(event.message.usage);
          else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            chars += event.delta.text.length;
            yield { type: "text", text: event.delta.text };
          }
        }
        final = await stream.finalMessage();
      } catch (e) {
        if (input) yield { type: "usage", ...input, outputTokens: Math.ceil(chars / 4) };
        if (e instanceof Anthropic.APIUserAbortError) {
          yield { type: "end", stop: "aborted" };
          return;
        }
        throw e;
      }
      for (const block of final.content) {
        if (block.type === "tool_use") {
          yield { type: "tool_call", call: { id: block.id, name: block.name, input: block.input as Record<string, unknown> } };
        }
      }
      yield { type: "usage", ...tokens(final.usage) };
      const stop = STOPS.find((s) => s === final.stop_reason) ?? "end_turn";
      yield { type: "end", stop, native: { model: req.model, content: final.content } };
    },
  };
}
