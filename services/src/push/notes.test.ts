import { describe, expect, it } from "vitest";
import { noteFor } from "./notes.js";
import type { PushJob } from "./types.js";

const mention = (over: Partial<Extract<PushJob, { kind: "mention" }>> = {}): PushJob => ({
  kind: "mention", roomId: "R", chatId: "C", seq: 4, authorName: "bea", text: "@aman can you look?", everyone: false, userIds: ["u1"], ...over,
});
const run = (over: Partial<Extract<PushJob, { kind: "run" }>> = {}): PushJob => ({
  kind: "run", roomId: "R", threadId: "T", number: 7, status: "done", userIds: ["u1"], ...over,
});

describe("noteFor", () => {
  it("a mention names its author and chat, and links to the chat", () => {
    expect(noteFor(mention(), { room: "dev", name: "general" })).toEqual({
      title: "bea mentioned you in #general", body: "dev: @aman can you look?", url: "/r/R/c/C", tag: "chat-C", urgency: "normal",
    });
    expect(noteFor(mention({ everyone: true }), { room: "dev", name: "general" }).title).toBe("bea mentioned everyone in #general");
  });

  it("a mention in a thread links to the thread", () => {
    expect(noteFor(mention({ chatId: "T" }), { room: "dev", name: "pr-check", thread: 7 }))
      .toMatchObject({ title: "bea mentioned you in #pr-check", url: "/r/R/t/7", tag: "thread-T" });
  });

  it("cuts a long mention to 140 code points on one line", () => {
    const { body } = noteFor(mention({ text: `line one\n\n${"😀".repeat(200)}` }), { room: "dev", name: "general" });
    const excerpt = body.slice("dev: ".length);
    expect([...excerpt]).toHaveLength(140);
    expect(excerpt.startsWith("line one 😀")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("a run's ending says how it ended", () => {
    const at = { room: "dev", name: "pr-check" };
    expect(noteFor(run({ summary: "Opened PR #12." }), at)).toEqual({
      title: "#pr-check finished", body: "dev: Opened PR #12.", url: "/r/R/t/7", tag: "thread-T", urgency: "normal",
    });
    expect(noteFor(run({ summary: "" }), at).body).toBe("dev: The agent answered.");
    expect(noteFor(run({ status: "failed", reason: "The agent hit an error." }), at))
      .toMatchObject({ title: "#pr-check failed", body: "dev: The agent hit an error." });
    expect(noteFor(run({ status: "capped", reason: "The room's budget is used up." }), at).title)
      .toBe("#pr-check stopped: the room's budget is used up");
    expect(noteFor(run({ status: "stopped", reason: "Stopped by bea.", stoppedBy: "bea" }), at).title).toBe("#pr-check was stopped by bea");
  });

  it("an approval is urgent and tagged per step", () => {
    const job: PushJob = { kind: "approval", roomId: "R", threadId: "T", number: 7, runId: "RUN", step: 3, title: "Comment on PR #12" };
    expect(noteFor(job, { room: "dev", name: "pr-check" })).toEqual({
      title: "#pr-check needs approval", body: "dev: Comment on PR #12", url: "/r/R/t/7", tag: "approval-RUN-3", urgency: "high",
    });
  });
});
