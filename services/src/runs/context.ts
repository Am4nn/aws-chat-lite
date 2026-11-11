import type { Message } from "../chat/model.js";
import type { ModelMessage, ToolCall } from "../models/gateway.js";
import type { RunEvent } from "../threads/types.js";

type Assistant = Extract<ModelMessage, { role: "assistant" }>;

/** The model can't open files, so a message names its attachments for it. */
const withAttachments = (text: string, names: string[] = []) => [text, ...names.map((name) => `[attached: ${name}]`)].join("\n");

/** The log without what failed attempts wrote: a `text.reset` voids the text and native turn its turn wrote before it. */
function withoutVoided(events: RunEvent[]): RunEvent[] {
  let kept: RunEvent[] = [];
  for (const e of events) {
    if (e.type === "text.reset") kept = kept.filter((k) => !((k.type === "text" || k.type === "model.turn") && k.turn === e.turn));
    else kept.push(e);
  }
  return kept;
}

/**
 * What the model sees: the thread before the run, then the run so far, rebuilt from its event log. The log is the
 * source of truth, so a model step that is retried sees exactly what members saw stream, less any attempt voided.
 *
 * The context starts at a member's message: providers reject one that opens with an assistant turn.
 */
export function buildContext(prior: Message[], events: RunEvent[]): ModelMessage[] {
  const from = prior.findIndex((m) => m.authorId !== "agent");
  const messages: ModelMessage[] = (from < 0 ? [] : prior.slice(from)).map((m) =>
    m.authorId === "agent" ? { role: "assistant", text: m.text } : { role: "user", author: m.authorName, text: withAttachments(m.text, m.attachments.map((a) => a.name)) },
  );
  const calls = new Map<number, ToolCall>();
  // The assistant message this run is writing, and whether it is still open: a tool result or a steer closes it.
  let current: Assistant | undefined;
  let open = false;
  const assistant = () => {
    if (!current || !open) messages.push((current = { role: "assistant", text: "" }));
    open = true;
    return current;
  };

  for (const e of withoutVoided(events)) {
    if (e.type === "text") {
      assistant().text += e.text;
    } else if (e.type === "model.turn") {
      assistant().native = { model: e.model, content: e.content };
    } else if (e.type === "step.started") {
      // A turn that asked for several tools runs them one step at a time, so its later calls start after its earlier
      // results. A native turn is replayed verbatim with every call it made, and the API wants all their results right
      // after it, so those calls stay on its message. Every turn that calls tools logs its native turn first.
      if (current?.native) open = true;
      const turn = assistant();
      turn.toolCalls = [...(turn.toolCalls ?? []), e.call];
      calls.set(e.step, e.call);
    } else if (e.type === "step.finished") {
      messages.push({ role: "tool", toolCallId: calls.get(e.step)?.id ?? "", output: e.output, isError: !e.ok });
      open = false;
    } else if (e.type === "steer") {
      messages.push({ role: "user", author: e.authorName, text: withAttachments(e.text, e.attachments) });
      open = false;
    }
  }
  return messages;
}

/**
 * The run's answer: every text event in order (what viewers saw stream, less any attempt voided), and the final turn's text, the part
 * after the last tool step or steer, which the thread's card summarizes.
 */
export function answerOf(events: RunEvent[]): { text: string; final: string } {
  let text = "";
  let final = "";
  for (const e of withoutVoided(events)) {
    if (e.type === "text") {
      text += e.text;
      final += e.text;
    } else if (e.type === "step.started" || e.type === "step.finished" || e.type === "steer") {
      final = "";
    }
  }
  return { text, final: final.trim() };
}
