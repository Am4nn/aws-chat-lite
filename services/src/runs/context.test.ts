import { describe, expect, it } from "vitest";
import type { Message } from "../chat/model.js";
import type { RunEvent, RunEventBody } from "../threads/types.js";
import { answerOf, buildContext } from "./context.js";

const message = (seq: number, authorId: string, authorName: string, text: string): Message => ({
  roomId: "r", chatId: "t", seq, authorId, authorName, text, createdAt: "2026-11-11T00:00:00.000Z",
  attachments: [], reactions: {}, mentions: [], everyone: false,
});
const events = (...bodies: RunEventBody[]): RunEvent[] =>
  bodies.map((b, i) => ({ ...b, seq: i + 1, at: "2026-11-11T00:00:00.000Z" }) as RunEvent);

const call = (n: number) => ({ id: `call-${n}`, name: "fake.lookup", input: { query: "q" } });
const started = (n: number): RunEventBody => ({ type: "step.started", step: n, call: call(n), detail: "q" });
const finished = (n: number, ok = true): RunEventBody => ({ type: "step.finished", step: n, output: `out ${n}`, ms: 5, ok });

describe("buildContext", () => {
  it("prior messages, then tool calls, their results and the merged answer text", () => {
    const prior = [message(1, "u1", "aman", "hi"), message(2, "agent", "agent", "earlier answer")];
    const run = events(
      { type: "run.started", model: "fake", startedBy: "aman" },
      started(1), finished(1), { type: "usage", model: "fake", inputTokens: 1, outputTokens: 1, costMicros: 18 },
      { type: "text", text: "a ", turn: 1 }, { type: "text", text: "b", turn: 1 },
    );
    expect(buildContext(prior, run)).toEqual([
      { role: "user", author: "aman", text: "hi" },
      { role: "assistant", text: "earlier answer" },
      { role: "assistant", text: "", toolCalls: [call(1)] },
      { role: "tool", toolCallId: "call-1", output: "out 1", isError: false },
      { role: "assistant", text: "a b" },
    ]);
  });

  it("a steer between steps becomes a user message in that position", () => {
    const run = events(
      started(1), finished(1, false),
      { type: "steer", messageSeq: 2, authorName: "ravi", text: "also check prod" },
      started(2), finished(2),
    );
    expect(buildContext([message(1, "u1", "aman", "go")], run)).toEqual([
      { role: "user", author: "aman", text: "go" },
      { role: "assistant", text: "", toolCalls: [call(1)] },
      { role: "tool", toolCallId: "call-1", output: "out 1", isError: true },
      { role: "user", author: "ravi", text: "also check prod" },
      { role: "assistant", text: "", toolCalls: [call(2)] },
      { role: "tool", toolCallId: "call-2", output: "out 2", isError: false },
    ]);
  });

  it("text before a tool call stays in the same assistant message", () => {
    const run = events({ type: "text", text: "Let me look.", turn: 1 }, started(1), finished(1));
    expect(buildContext([], run).slice(0, 1)).toEqual([{ role: "assistant", text: "Let me look.", toolCalls: [call(1)] }]);
  });
});

describe("a failed attempt's text", () => {
  // Turn 2 wrote "Half an" and failed; its retry reset the turn and answered again.
  const run = events(
    { type: "text", text: "Let me look.", turn: 1 }, started(1), finished(1),
    { type: "text", text: "\n\nHalf an", turn: 2 },
    { type: "steer", messageSeq: 2, authorName: "ravi", text: "more" },
    { type: "text.reset", turn: 2 },
    { type: "text", text: "\n\nWhole answer.", turn: 2 },
  );
  it("is left out of the answer", () => {
    expect(answerOf(run)).toEqual({ text: "Let me look.\n\nWhole answer.", final: "Whole answer." });
  });
  it("is left out of what the model sees, while the steer read in that attempt stays", () => {
    expect(buildContext([], run).slice(2)).toEqual([
      { role: "user", author: "ravi", text: "more" },
      { role: "assistant", text: "\n\nWhole answer." },
    ]);
  });
});

describe("answerOf", () => {
  it("joins every text event, and takes the final turn's text for the summary", () => {
    const run = events(
      { type: "text", text: "Let me look.", turn: 1 }, started(1), finished(1),
      { type: "text", text: "\n\nFirst answer.", turn: 1 },
      { type: "steer", messageSeq: 2, authorName: "ravi", text: "more" },
      { type: "text", text: "\n\nSecond ", turn: 1 }, { type: "text", text: "answer.", turn: 1 },
    );
    expect(answerOf(run)).toEqual({ text: "Let me look.\n\nFirst answer.\n\nSecond answer.", final: "Second answer." });
  });

  it("a run that ends during a step has no final text", () => {
    expect(answerOf(events({ type: "text", text: "Looking.", turn: 1 }, started(1)))).toEqual({ text: "Looking.", final: "" });
  });
});
