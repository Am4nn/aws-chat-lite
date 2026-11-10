import { fakeModel } from "./fake.js";

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ModelMessage =
  | { role: "user"; author: string; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; output: string };
export type ToolSpec = { name: string; description: string; inputSchema: object };
export type ModelRequest = {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
};
export type ModelChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; costMicros: number };

export interface ModelGateway {
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;
}

export const NAME_PROMPT = "Name this thread in 1 to 3 lowercase words joined by dashes. Reply with the name only.";

export function gateway(env: Record<string, string | undefined> = process.env): ModelGateway {
  if (env.MODEL_GATEWAY === "fake") return fakeModel();
  throw new Error(`Unknown model gateway: ${env.MODEL_GATEWAY}`);
}
