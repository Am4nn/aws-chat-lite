import type { Message } from "../chat/model.js";
import type { ModelMessage, ToolCall } from "../models/gateway.js";
import type { RunEvent } from "../threads/types.js";

type Assistant = Extract<ModelMessage, { role: "assistant" }>;

/** The model can't open files, so a message names its attachments for it. */
const withAttachments = (text: string, names: string[] = []) => [text, ...names.map((name) => `[attached: ${name}]`)].join("\n");

/** Whether an event is in a lane: one with no lane is the thread's own agent's (lane 0). */
export const inLane = (lane: number) => (e: RunEvent) => (e.lane ?? 0) === lane;

/**
 * One lane of the log, without what failed attempts wrote: a `text.reset` voids the text and native turn its turn
 * wrote before it. Each lane counts its own turns, so a reset only voids its own lane's.
 */
function withoutVoided(events: RunEvent[], lane: number): RunEvent[] {
  let kept: RunEvent[] = [];
  for (const e of events.filter(inLane(lane))) {
    if (e.type === "text.reset") kept = kept.filter((k) => !((k.type === "text" || k.type === "model.turn") && k.turn === e.turn));
    else kept.push(e);
  }
  return kept;
}

/**
 * The thread before the run, as the model reads it. It starts at a member's message: providers reject a context that
 * opens with an assistant turn.
 */
export function threadMessages(prior: Message[]): ModelMessage[] {
  const from = prior.findIndex((m) => m.authorId !== "agent");
  return (from < 0 ? [] : prior.slice(from)).map((m) =>
    m.authorId === "agent" ? { role: "assistant", text: m.text } : { role: "user", author: m.authorName, text: withAttachments(m.text, m.attachments.map((a) => a.name)) },
  );
}

/**
 * What one lane's model sees: how its work opened (the thread before the run, or a helper's task), then that lane of
 * the run so far, rebuilt from the event log. The log is the source of truth, so a model step that is retried sees
 * exactly what members saw stream, less any attempt voided. The main lane sees a helper's work only as its delegate
 * call's result.
 */
export function buildContext(opening: ModelMessage[], events: RunEvent[], lane = 0): ModelMessage[] {
  const messages = [...opening];
  const calls = new Map<number, ToolCall>();
  // The assistant message this run is writing; a tool result or a steer ends it.
  let current: Assistant | undefined;
  const assistant = () => {
    if (!current) messages.push((current = { role: "assistant", text: "" }));
    return current;
  };

  for (const e of withoutVoided(events, lane)) {
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
      messages.push({ role: "user", author: e.authorName, text: withAttachments(e.text, e.attachments) });
      current = undefined;
    }
  }
  return messages;
}

/**
 * A lane's answer: every text event in order (what viewers saw stream, less any attempt voided), and the final turn's
 * text, the part after the last tool step or steer, which the thread's card (or the helper's step) summarizes.
 */
export function answerOf(events: RunEvent[], lane = 0): { text: string; final: string } {
  let text = "";
  let final = "";
  for (const e of withoutVoided(events, lane)) {
    if (e.type === "text") {
      text += e.text;
      final += e.text;
    } else if (e.type === "step.started" || e.type === "step.finished" || e.type === "steer") {
      final = "";
    }
  }
  return { text, final: final.trim() };
}
