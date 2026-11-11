import type { Provider, TokenUsage } from "./catalog.js";

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
/** The provider's assistant content, verbatim, so a tool round can be replayed to the same model exactly. */
export type NativeTurn = { model: string; content: unknown };
export type ModelMessage =
  | { role: "user"; author: string; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[]; native?: NativeTurn }
  | { role: "tool"; toolCallId: string; output: string; isError?: boolean };
export type ToolSpec = { name: string; description: string; inputSchema: object };
export type ModelRequest = {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  /** The most output tokens the call may produce. */
  maxTokens: number;
  effort?: "low" | "medium";
  cache?: boolean;
  signal?: AbortSignal;
};
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "aborted";
export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | ({ type: "usage" } & TokenUsage)
  /** Always the last chunk. */
  | { type: "end"; stop: StopReason; native?: NativeTurn };
export type ModelChunk =
  | Exclude<ProviderChunk, { type: "usage" }>
  | ({ type: "usage"; costMicros: number } & TokenUsage);

/** One model vendor's API, reporting tokens; the gateway turns them into cost. */
export interface ModelProvider {
  stream(req: ModelRequest): AsyncIterable<ProviderChunk>;
}

export interface ModelGateway {
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;
  servedBy(model: string): Provider;
}

export const NAME_PROMPT = "Name this thread in 1 to 3 lowercase words joined by dashes. Reply with the name only.";
