import type { Message } from "../chat/model.js";
import type { ModelMessage, ToolCall } from "../models/gateway.js";
import type { RunEvent } from "../threads/types.js";

type Assistant = Extract<ModelMessage, { role: "assistant" }>;

/** The model can't open files, so a message names its attachments for it. */
const withAttachments = (m: Message) => [m.text, ...m.attachments.map((a) => `[attached: ${a.name}]`)].join("\n");

/**
 * What the model sees: the thread before the run, then the run so far, rebuilt from its event log. The log is the
 * source of truth, so a model step that is retried sees exactly what members saw stream.
 *
 * The context starts at a member's message: providers reject one that opens with an assistant turn.
 */
export function buildContext(prior: Message[], events: RunEvent[]): ModelMessage[] {
  const from = prior.findIndex((m) => m.authorId !== "agent");
  const messages: ModelMessage[] = (from < 0 ? [] : prior.slice(from)).map((m) =>
    m.authorId === "agent" ? { role: "assistant", text: m.text } : { role: "user", author: m.authorName, text: withAttachments(m) },
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
    } else if (e.type === "model.turn") {
      assistant().native = { model: e.model, content: e.content };
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

/**
 * The run's answer: every text event in order (exactly what viewers saw stream), and the final turn's text, the part
 * after the last tool step or steer, which the thread's card summarizes.
 */
export function answerOf(events: RunEvent[]): { text: string; final: string } {
  let text = "";
  let final = "";
  for (const e of events) {
    if (e.type === "text") {
      text += e.text;
      final += e.text;
    } else if (e.type === "step.started" || e.type === "step.finished" || e.type === "steer") {
      final = "";
    }
  }
  return { text, final: final.trim() };
}
