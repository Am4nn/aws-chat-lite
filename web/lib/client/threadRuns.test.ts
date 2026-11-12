import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/types";
import { threadRuns } from "./threadRuns";

const msg = (seq: number, text: string, agent?: { runId: string; firstSeq: number }) =>
  ({ seq, text, authorId: agent ? "agent" : "u1", ...(agent && { agent }) }) as unknown as Message;

describe("threadRuns", () => {
  it("lists each run oldest first, named by the message that started it", () => {
    const messages = [
      msg(1, "check PR 41"), msg(2, "Looks fine.", { runId: "r1", firstSeq: 1 }),
      msg(3, "summarise the diff"), msg(4, "Two files changed.", { runId: "r2", firstSeq: 3 }),
    ];
    expect(threadRuns(messages, "r2")).toEqual([{ runId: "r1", prompt: "check PR 41" }, { runId: "r2", prompt: "summarise the diff" }]);
  });

  it("adds the latest run while it has no answer yet", () => {
    const messages = [msg(1, "check PR 41"), msg(2, "Looks fine.", { runId: "r1", firstSeq: 1 }), msg(3, "now post it")];
    expect(threadRuns(messages, "r2")).toEqual([{ runId: "r1", prompt: "check PR 41" }, { runId: "r2", prompt: "" }]);
  });

  it("is empty before anything has run", () => expect(threadRuns([msg(1, "hi")], undefined)).toEqual([]));
});
