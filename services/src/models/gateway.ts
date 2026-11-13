import type { Provider, TokenUsage } from "./catalog.js";

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
/** The provider's assistant content, verbatim, so a tool round can be replayed to the same model exactly. */
type NativeTurn = { model: string; content: unknown };
export type InlineImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
/** An image on a user message; `data` (base64) is filled in just before a call, and only for a model that may see it. */
export type ImagePart = { name: string; mediaType: InlineImageType; key: string; size: number; data?: string };
export type ModelMessage =
  /** `author` is unset on text the app itself adds, such as a chat's background. */
  | { role: "user"; author?: string; text: string; images?: ImagePart[] }
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
  /** The last chunk of a call that ends. A call that drops throws instead, after a usage chunk for what it used. */
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
