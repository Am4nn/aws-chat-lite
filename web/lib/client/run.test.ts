import { describe, expect, it } from "vitest";
import type { Message, RunEvent } from "../types";
import { settledLine } from "./approvals";
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

  it("only keeps model.turn among the events", () => {
    const before = run(ev(1, { type: "text", text: "a" }));
    const turn = ev(2, { type: "model.turn", model: "m", content: [] });
    expect(applyRunEvent(before, turn)).toEqual({ ...before, lastSeq: 2, events: [...before.events, turn] });
  });
});

describe("applyRunEvent: approvals and sources", () => {
  const call = { id: "c", name: "github_comment", input: { number: 4, body: "LGTM" } };
  const asked = ev(1, { type: "approval.requested", step: 1, call, title: "Comment on #4 in a/b?", expiresAt: "2026-11-11T12:00:00Z" });

  it("an approval request becomes a pending item, and its settlement updates it in place", () => {
    const pending = run(asked);
    expect(pending.items).toEqual([{
      kind: "approval", step: 1, title: "Comment on #4 in a/b?", call, expiresAt: "2026-11-11T12:00:00Z", status: "pending",
    }]);
    const settled = run(asked, ev(2, { type: "approval.settled", step: 1, decision: "approved", by: "bea" }));
    expect(settled.items).toHaveLength(1);
    expect(settled.items[0]).toMatchObject({ status: "approved", by: "bea" });
    expect(settledLine(settled.items[0] as Parameters<typeof settledLine>[0])).toBe("Approved by bea");
  });

  it("an approval the stop beat to its step says so, and one whose step ran doesn't", () => {
    const settled = ev(2, { type: "approval.settled", step: 1, decision: "approved", by: "bea" });
    const stopped = ev(3, { type: "run.finished", status: "stopped", reason: "Stopped by aman.", ms: 1, steps: 0, costMicros: 0 });
    expect(run(asked, settled, stopped).items[0]).toMatchObject({ status: "approved", stoppedFirst: true });
    const ran = run(asked, settled, ev(3, { type: "step.started", step: 1, call, detail: "" }), { ...stopped, seq: 4 } as RunEvent);
    expect(ran.items[0]).not.toHaveProperty("stoppedFirst");
  });

  it("an approval is its own row, in event order", () => {
    const v = run(ev(1, { type: "step.started", step: 1, call, detail: "" }), ev(2, { type: "step.finished", step: 1, output: "", ms: 1, ok: true }), { ...asked, seq: 3, step: 2 } as RunEvent);
    expect(runRows(v, [], []).map((r) => r.key)).toEqual(["step:1", "approval:2"]);
  });

  it("collects each step's sources once per url", () => {
    const src = (url: string) => ({ title: url, url });
    const v = run(
      ev(1, { type: "step.finished", step: 1, output: "", ms: 1, ok: true, sources: [src("https://a.dev/1"), src("https://b.dev")] }),
      ev(2, { type: "step.finished", step: 2, output: "", ms: 1, ok: true, sources: [src("https://a.dev/1")] }),
      ev(3, { type: "step.finished", step: 3, output: "", ms: 1, ok: true }),
    );
    expect(v.sources.map((x) => x.url)).toEqual(["https://a.dev/1", "https://b.dev"]);
  });

  it("collects generated images in step order, once per path, and puts each on its step", () => {
    const call = { id: "c", name: "image_generate", input: {} };
    const v = run(
      ev(1, { type: "step.started", step: 1, call, detail: "" }),
      ev(2, { type: "step.finished", step: 1, output: "", ms: 1, ok: true, image: { path: "images/a.png", aspect: "1:1" } }),
      ev(3, { type: "step.finished", step: 2, output: "", ms: 1, ok: true, image: { path: "images/b.png", aspect: "16:9" } }),
      ev(4, { type: "step.finished", step: 3, output: "", ms: 1, ok: true, image: { path: "images/a.png", aspect: "1:1" } }),
      ev(5, { type: "step.finished", step: 4, output: "", ms: 1, ok: true }),
    );
    expect(v.images).toEqual([{ path: "images/a.png", aspect: "1:1" }, { path: "images/b.png", aspect: "16:9" }]);
    expect(v.items[0]).toMatchObject({ kind: "step", image: { path: "images/a.png" } });
  });
});

describe("applyRunEvent: helper lanes", () => {
  const call = (id: string, name: string, input = {}) => ({ id, name, input });
  const delegated = [
    ev(1, { type: "text", text: "Checking.", turn: 1 }),
    ev(2, { type: "step.started", step: 1, call: call("d", "delegate", { agent: "researcher", task: "find docs" }), detail: "researcher: find docs" }),
    ev(3, { type: "helper.started", lane: 1, step: 1, agentId: "a2", agentName: "researcher", task: "find docs", model: "claude-haiku-5-5" }),
    ev(4, { type: "step.started", lane: 1, step: 2, call: call("l1", "fake.lookup"), detail: "a" }),
    ev(5, { type: "step.finished", lane: 1, step: 2, output: "doc a", ms: 5, ok: true }),
    ev(6, { type: "step.started", lane: 1, step: 3, call: call("l2", "fake.lookup"), detail: "b" }),
    ev(7, { type: "step.finished", lane: 1, step: 3, output: "doc b", ms: 5, ok: true, sources: [{ title: "B", url: "https://b.dev" }] }),
    ev(8, { type: "text", lane: 1, text: "Found 3 docs.", turn: 1 }),
    ev(9, { type: "helper.finished", lane: 1, step: 1, status: "done", summary: "found 3 docs", steps: 2, ms: 10, costMicros: 40 }),
    ev(10, { type: "step.finished", step: 1, output: "Found 3 docs.", ms: 20, ok: true }),
    ev(11, { type: "text", text: "\n\nAll good.", turn: 2 }),
  ];

  it("keeps a helper's steps and text out of the run's own, on its delegate step", () => {
    const v = run(...delegated);
    expect(v.text).toBe("Checking.\n\nAll good.");
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({
      kind: "step", name: "delegate", status: "done",
      helper: { lane: 1, agentName: "researcher", task: "find docs", status: "done", summary: "found 3 docs", text: "Found 3 docs." },
    });
    const helper = v.items[0].kind === "step" ? v.items[0].helper : undefined;
    expect(helper?.items).toHaveLength(2);
    expect(v.sources.map((s) => s.url)).toEqual(["https://b.dev"]);
  });

  it("keeps every event, in order", () => {
    expect(run(...delegated).events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("shows a helper's approvals in the run's rows, right after its delegate step", () => {
    const asked = ev(5, { type: "approval.requested", lane: 1, step: 2, call: call("w", "github_comment"), title: "Comment?", expiresAt: "2026-11-11T12:00:00Z" });
    const v = run(...delegated.slice(0, 3), asked);
    expect(runRows(v, [], []).map((r) => r.key)).toEqual(["step:1", "approval:2"]);
  });
});

describe("runRows", () => {
  const step = (seq: number, n: number) => ev(seq, { type: "step.started", step: n, call: { id: "c", name: "x", input: {} }, detail: "" });
  const steer = (seq: number, messageSeq: number) => ev(seq, { type: "steer", messageSeq, authorName: "ann", text: "t" + messageSeq });
  const m = (seq: number, clientId?: string) => ({ seq, clientId, authorName: "ann", text: "t" + seq }) as Message;

  it("lists steps and read steers in event order, then queued steers, then unsent ones", () => {
    const v = run(step(1, 1), steer(2, 5), step(3, 2));
    const rows = runRows(v, [m(5), m(6)], [{ clientId: "p1", text: "later", createdAt: "", attachments: [] }]);
    expect(rows.map((r) => (r.kind === "steer" ? `${r.key} ${r.state}` : r.key))).toEqual([
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
