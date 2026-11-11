import { inlineType } from "../chat/files.js";
import type { Attachment, Message } from "../chat/model.js";
import type { ImagePart, ModelMessage, ToolCall } from "../models/gateway.js";
import type { GeneratedImage, RunEvent } from "../threads/types.js";

type Assistant = Extract<ModelMessage, { role: "assistant" }>;

/**
 * A member's message as the model gets it. The model can't open files, so the text names each attachment; an image
 * also goes along as a part, whose bytes are filled in only for a model that may see them.
 */
function memberMessage(author: string, text: string, attachments: Attachment[] = []): ModelMessage {
  const images = attachments.flatMap(({ key, name, size, type }): ImagePart[] => (inlineType(type) ? [{ name, mediaType: type, key, size }] : []));
  const named = [text, ...attachments.map((a) => `[attached: ${a.name}]`)].join("\n");
  return { role: "user", author, text: named, ...(images.length > 0 && { images }) };
}

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
    m.authorId === "agent" ? { role: "assistant", text: m.text } : memberMessage(m.authorName, m.text, m.attachments),
  );
  const calls = new Map<number, ToolCall>();
  // The assistant message this run is writing; a tool result or a steer ends it.
  let current: Assistant | undefined;
  const assistant = () => {
    if (!current) messages.push((current = { role: "assistant", text: "" }));
    return current;
  };

  for (const e of withoutVoided(events)) {
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
      messages.push(memberMessage(e.authorName, e.text, e.attachments));
      current = undefined;
    }
  }
  return messages;
}

/**
 * The run's answer: every text event in order (what viewers saw stream, less any attempt voided), the final turn's text, the part
 * after the last tool step or steer, which the thread's card summarizes, and the images its steps made.
 */
export function answerOf(events: RunEvent[]): { text: string; final: string; images: GeneratedImage[] } {
  let text = "";
  let final = "";
  const images: GeneratedImage[] = [];
  for (const e of withoutVoided(events)) {
    if (e.type === "text") {
      text += e.text;
      final += e.text;
    } else if (e.type === "step.started" || e.type === "step.finished" || e.type === "steer") {
      final = "";
      if (e.type === "step.finished" && e.image) images.push(e.image);
    }
  }
  return { text, final: final.trim(), images };
}
