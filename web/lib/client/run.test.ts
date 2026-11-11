import { describe, expect, it } from "vitest";
import type { Message, RunEvent } from "../types";
import { applyRunEvent, emptyRun, runRows, splitSyncLines, stepsLabel } from "./run";

type Body = Record<string, unknown>;
const ev = (seq: number, body: Body) => ({ seq, at: "2026-11-11T10:00:00Z", ...body }) as RunEvent;
const run = (...events: RunEvent[]) => events.reduce(applyRunEvent, emptyRun());

describe("applyRunEvent", () => {
  it("turns step.started + step.finished into one done step", () => {
    const v = run(
      ev(1, { type: "step.started", step: 1, call: { id: "c", name: "search", input: {} }, detail: "q" }),
      ev(2, { type: "step.finished", step: 1, output: "found", ms: 800, ok: true }),
    );
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ kind: "step", name: "search", status: "done", output: "found", ms: 800 });
  });

  it("marks a failed step", () => {
    const v = run(
      ev(1, { type: "step.started", step: 1, call: { id: "c", name: "x", input: {} }, detail: "" }),
      ev(2, { type: "step.finished", step: 1, output: "boom", ms: 1, ok: false }),
    );
    expect(v.items[0]).toMatchObject({ status: "failed" });
  });

  it("concatenates text events", () => {
    const v = run(ev(1, { type: "text", text: "a" }), ev(2, { type: "text", text: "b" }), ev(3, { type: "text", text: "c" }));
    expect(v.text).toBe("abc");
  });

  it("drops a failed attempt's text when its turn is reset, keeping earlier turns", () => {
    const v = run(
      ev(1, { type: "text", text: "Looking.", turn: 1 }),
      ev(2, { type: "text", text: " Half", turn: 2 }), ev(3, { type: "text", text: " an", turn: 2 }),
      ev(4, { type: "text.reset", turn: 2 }),
      ev(5, { type: "text", text: " Whole", turn: 2 }),
      ev(6, { type: "text.reset", turn: 2 }),
      ev(7, { type: "text", text: " Final.", turn: 2 }),
    );
    expect(v.text).toBe("Looking. Final.");
  });

  it("ignores a repeated or older seq", () => {
    const e = ev(1, { type: "text", text: "a" });
    const once = run(e);
    expect(applyRunEvent(once, e)).toBe(once);
    expect(applyRunEvent(run(ev(2, { type: "text", text: "a" })), ev(1, { type: "text", text: "z" })).text).toBe("a");
  });

  it("places a steer after the steps before it", () => {
    const v = run(
      ev(1, { type: "step.started", step: 1, call: { id: "c", name: "x", input: {} }, detail: "" }),
      ev(2, { type: "steer", messageSeq: 7, authorName: "ann", text: "faster" }),
    );
    expect(v.items.map((i) => i.kind)).toEqual(["step", "steer"]);
  });

  it("ignores an overlapping replay after a resume", () => {
    const a = ev(1, { type: "text", text: "a" });
    const b = ev(2, { type: "text", text: "b" });
    expect([a, b, a, b, ev(3, { type: "text", text: "c" })].reduce(applyRunEvent, emptyRun()).text).toBe("abc");
  });

  it("records the end status and reason", () => {
    const v = run(ev(1, { type: "run.finished", status: "stopped", reason: "by ann", ms: 5, steps: 0, costMicros: 9 }));
    expect(v).toMatchObject({ status: "stopped", reason: "by ann", costMicros: 9 });
  });

  it("sums usage cost across every job", () => {
    const v = run(
      ev(1, { type: "usage", model: "claude-haiku-5-5", job: "route", inputTokens: 1, outputTokens: 1, costMicros: 100 }),
      ev(2, { type: "usage", model: "claude-sonnet-5-5", job: "run", inputTokens: 1, outputTokens: 1, costMicros: 900 }),
      ev(3, { type: "usage", model: "sandbox", job: "sandbox", inputTokens: 0, outputTokens: 0, costMicros: 61 }),
    );
    expect(v.costMicros).toBe(1061);
  });

  it("puts the files a sandbox step saved on that step", () => {
    const v = run(
      ev(1, { type: "step.started", step: 1, call: { id: "a", name: "x", input: {} }, detail: "" }),
      ev(2, { type: "step.started", step: 2, call: { id: "b", name: "sandbox_run", input: {} }, detail: "" }),
      ev(3, { type: "files.synced", step: 2, written: ["a"], deleted: [], notes: [] }),
    );
    expect(v.items.map((i) => i.kind === "step" && i.files)).toEqual([undefined, { written: ["a"], deleted: [], notes: [] }]);
  });

  it("keeps the pick and takes the model from routed", () => {
    const v = run(
      ev(1, { type: "run.started", pick: "auto", startedBy: "u" }),
      ev(2, { type: "routed", model: "claude-haiku-5-5", by: "auto" }),
    );
    expect(v).toMatchObject({ pick: "auto", model: "claude-haiku-5-5", startedAt: "2026-11-11T10:00:00Z" });
  });

  it("ignores model.turn except for lastSeq", () => {
    const before = run(ev(1, { type: "text", text: "a" }));
    const after = applyRunEvent(before, ev(2, { type: "model.turn", model: "m", content: [] }));
    expect(after).toEqual({ ...before, lastSeq: 2 });
  });
});

describe("runRows", () => {
  const step = (seq: number, n: number) => ev(seq, { type: "step.started", step: n, call: { id: "c", name: "x", input: {} }, detail: "" });
  const steer = (seq: number, messageSeq: number) => ev(seq, { type: "steer", messageSeq, authorName: "ann", text: "t" + messageSeq });
  const m = (seq: number, clientId?: string) => ({ seq, clientId, authorName: "ann", text: "t" + seq }) as Message;

  it("lists steps and read steers in event order, then queued steers, then unsent ones", () => {
    const v = run(step(1, 1), steer(2, 5), step(3, 2));
    const rows = runRows(v, [m(5), m(6)], [{ clientId: "p1", text: "later", createdAt: "", attachments: [] }]);
    expect(rows.map((r) => (r.kind === "step" ? r.key : `${r.key} ${r.state}`))).toEqual([
      "step:1", "s:5 read", "step:2", "s:6 queued", "c:p1 sending",
    ]);
  });

  it("marks a steer the run ended without reading as not read, not queued", () => {
    const ended = run(step(1, 1), ev(2, { type: "run.finished", status: "done", ms: 1, steps: 1, costMicros: 0 }));
    expect(runRows(ended, [m(5)], []).map((r) => r.kind === "steer" && r.state)).toEqual([false, "unread"]);
  });

  it("keeps a steer the same row from sending to queued to read", () => {
    const pending = [{ clientId: "k", text: "t", createdAt: "", attachments: [] }];
    const sending = runRows(emptyRun(), [], pending)[0];
    const queued = runRows(emptyRun(), [m(5, "k")], [])[0];
    const read = runRows(run(steer(1, 5)), [m(5, "k")], [])[0];
    expect([sending.key, queued.key, read.key]).toEqual(["c:k", "c:k", "c:k"]);
  });

  it("marks an unsent steer that failed", () => {
    const rows = runRows(emptyRun(), [], [{ clientId: "k", text: "t", createdAt: "", attachments: [], failed: true }]);
    expect(rows[0]).toMatchObject({ kind: "steer", state: "failed", clientId: "k" });
  });
});

describe("splitSyncLines", () => {
  const files = { written: ["a.csv", "b.csv"], deleted: ["c"], notes: ["n.txt was changed by #12 after this run loaded it; this run's version replaced it."] };
  it("takes the lines about room files off the end of a sandbox step's output", () => {
    const output = ["exit 0 · 812 ms", "--- stdout", "hi", "Saved to room files: a.csv, b.csv", "Deleted from room files: c", files.notes[0]].join("\n");
    expect(splitSyncLines(output, files)).toEqual({
      output: "exit 0 · 812 ms\n--- stdout\nhi",
      lines: ["Saved to room files: a.csv, b.csv", "Deleted from room files: c", files.notes[0]],
    });
  });
  it("leaves the output whole when it doesn't end with them", () =>
    expect(splitSyncLines("exit 1 · 5 ms", files)).toEqual({ output: "exit 1 · 5 ms", lines: [] }));
});

describe("stepsLabel", () => {
  it.each([
    [1, 0, "1 step"],
    [3, 0, "3 steps"],
    [2, 1, "2 steps · 1 steer"],
    [2, 3, "2 steps · 3 steers"],
    [0, 1, "1 steer"],
  ])("%i steps and %i steers → %s", (steps, steers, label) => {
    expect(stepsLabel(steps, steers)).toBe(label);
  });
});
