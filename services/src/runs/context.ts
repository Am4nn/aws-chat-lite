import type { Message } from "../chat/model.js";
import type { ModelMessage, ToolCall } from "../models/gateway.js";
import type { RunEvent } from "../threads/types.js";

type Assistant = Extract<ModelMessage, { role: "assistant" }>;

/**
 * What the model sees: the thread before the run, then the run so far, rebuilt from its event log. The log is the
 * source of truth, so a model step that is retried sees exactly what members saw stream.
 */
export function buildContext(prior: Message[], events: RunEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = prior.map((m) =>
    m.authorId === "agent" ? { role: "assistant", text: m.text } : { role: "user", author: m.authorName, text: m.text },
  );
  const calls = new Map<number, ToolCall>();
  // The assistant message this run is writing; a tool result or a steer ends it.
  let current: Assistant | undefined;
  const assistant = () => {
    if (!current) messages.push((current = { role: "assistant", text: "" }));
    return current;
  };

  for (const e of events) {
    if (e.type === "text") {
      assistant().text += e.text;
    } else if (e.type === "step.started") {
      const turn = assistant();
      turn.toolCalls = [...(turn.toolCalls ?? []), e.call];
      calls.set(e.step, e.call);
    } else if (e.type === "step.finished") {
      messages.push({ role: "tool", toolCallId: calls.get(e.step)?.id ?? "", output: e.output, isError: !e.ok });
      current = undefined;
    } else if (e.type === "steer") {
      messages.push({ role: "user", author: e.authorName, text: e.text });
      current = undefined;
    }
  }
  return messages;
}
