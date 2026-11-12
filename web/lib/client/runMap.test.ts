import { describe, expect, it } from "vitest";
import type { RunEvent } from "../types";
import { edgePath, runMap, timeShares } from "./runMap";

type Body = Record<string, unknown>;
const T0 = Date.parse("2026-11-11T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const ev = (s: number, body: Body) => ({ seq: ++seq, at: at(s), ...body }) as RunEvent;
const usage = (s: number, o: Body) =>
  ev(s, { type: "usage", model: "m", job: "run", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, ...o });
const call = (id: string, name: string, input = {}) => ({ id, name, input });
const started = (s: number, step: number, name: string, lane?: number) =>
  ev(s, { type: "step.started", step, call: call(`c${step}`, name), detail: name, ...(lane && { lane }) });
const finished = (s: number, step: number, ms: number, lane?: number) =>
  ev(s, { type: "step.finished", step, output: `out ${step}`, ms, ok: true, ...(lane && { lane }) });

/** @reviewer searches and hands a task to @researcher in one turn; the helper looks twice, answers, and the run ends. */
const delegated = () => [
  ev(0, { type: "run.started", pick: "auto", startedBy: "aman", agentName: "reviewer" }),
  ev(1, { type: "text", text: "Checking.", turn: 1 }),
  usage(2, { inputTokens: 1000, outputTokens: 200, costMicros: 3000, ms: 2000 }),
  started(2, 1, "web_search"),
  finished(3, 1, 1000),
  started(3, 2, "delegate"),
  ev(3, { type: "helper.started", lane: 1, step: 2, agentId: "a2", agentName: "researcher", task: "find docs", model: "m" }),
  usage(4, { lane: 1, ms: 1000 }),
  started(4, 3, "fake.lookup", 1),
  finished(5, 3, 1000, 1),
  usage(6, { lane: 1, ms: 1000 }),
  started(6, 4, "fake.lookup", 1),
  finished(7, 4, 1000, 1),
  ev(8, { type: "text", lane: 1, text: "Found 3 docs.", turn: 3 }),
  usage(8, { lane: 1, ms: 1000 }),
  ev(8, { type: "helper.finished", lane: 1, step: 2, status: "done", summary: "found 3 docs", steps: 2, ms: 5000, costMicros: 0 }),
  finished(8, 2, 5000),
  ev(9, { type: "text", text: "\n\nAll good.", turn: 2 }),
  usage(9, { ms: 1000 }),
  ev(9, { type: "run.finished", status: "done", ms: 9000, steps: 4, costMicros: 3000 }),
];

const byId = (m: ReturnType<typeof runMap>, id: string) => m.nodes.find((n) => n.id === id)!;

describe("runMap", () => {
  const map = runMap(delegated(), T0 + 10_000);

  it("gives the run's own agent and each helper a lane", () => {
    expect(map.lanes.map((l) => [l.agent, l.helper])).toEqual([["reviewer", false], ["researcher", true]]);
  });

  it("starts at the prompt block: no card repeats the prompt, and the first calls hang off it", () => {
    expect(map.nodes.map((n) => n.kind)).not.toContain("ask");
    expect(map.edges.filter((e) => e.from === "prompt").map((e) => e.to)).toEqual(["step-1", "step-2"]);
  });

  it("names a helper's lane just under its first card, and leaves the run's own lane unnamed", () => {
    const first = byId(map, "step-3");
    expect(map.lanes[1].at).toEqual({ x: first.x, y: first.y + 72 + 6 });
    expect(map.lanes[0].at).toBeUndefined();
  });

  it("spaces cards 16 px apart from 24 px right of the prompt, level with the prompt's middle", () => {
    const m = runMap([usage(0, {}), started(0, 1, "a"), finished(1, 1, 1000), usage(1, {}), started(1, 2, "b")], T0);
    expect([byId(m, "step-1"), byId(m, "step-2")].map((n) => [n.x, n.y])).toEqual([[24, 12], [168, 12]]);
    expect(m.edges.find((e) => e.from === "prompt")?.d).toBe(edgePath({ x: 0, y: 48 }, { x: 24, y: 48 }));
  });

  it("stacks the calls of one turn in one column, a row apart", () => {
    const [search, handOff] = [byId(map, "step-1"), byId(map, "step-2")];
    expect(search.x).toBe(handOff.x);
    expect(handOff.y - search.y).toBe(80);
  });

  it("puts a helper's turns after its delegate step, and the run's answer after the helper", () => {
    const xs = ["step-2", "step-3", "step-4", "answer-1", "answer-0"].map((id) => byId(map, id).x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(5);
    expect(byId(map, "step-3").lane).toBe(1);
  });

  it("draws exactly two hand-offs: to the helper and back", () => {
    const helper = map.edges.filter((e) => e.helper);
    expect(helper.map((e) => [e.from, e.to])).toEqual([["step-2", "step-3"], ["answer-1", "answer-0"]]);
    expect(map.edges.find((e) => e.waitsForHelper)).toMatchObject({ from: "step-2", to: "answer-0" });
  });

  it("splits a turn's tokens and cost evenly over its calls", () => {
    expect(byId(map, "step-1")).toMatchObject({ tokens: 600, costMicros: 1500 });
    expect(byId(map, "step-2")).toMatchObject({ tokens: 600, costMicros: 1500 });
  });

  it("gives the remainder of an uneven split to the first call", () => {
    const m = runMap([usage(0, { inputTokens: 5, costMicros: 7 }), started(0, 1, "a"), started(0, 2, "b")], T0);
    expect([byId(m, "step-1"), byId(m, "step-2")].map((n) => [n.tokens, n.costMicros])).toEqual([[3, 4], [2, 3]]);
  });

  it("marks a step waiting on a member, and the edge into it", () => {
    const m = runMap([
      ev(0, { type: "run.started", pick: "auto", startedBy: "aman", agentName: "agent" }),
      usage(1, {}),
      ev(1, { type: "approval.requested", step: 1, call: call("w", "github_comment"), title: "Comment?", expiresAt: at(7200) }),
    ], T0 + 5000);
    expect(byId(m, "step-1")).toMatchObject({ status: "waiting", ms: 4000, approval: { title: "Comment?", status: "pending" } });
    expect(m.edges.find((e) => e.to === "step-1")).toMatchObject({ from: "prompt", waiting: true });
  });

  it("hangs the files a sandbox step saved on it, and adds its sandbox cost", () => {
    const m = runMap([
      started(0, 3, "sandbox_run"),
      ev(1, { type: "files.synced", step: 3, written: ["out.txt", "b", "c"], deleted: [], notes: [] }),
      usage(1, { job: "sandbox", costMicros: 61 }),
    ], T0);
    expect(byId(m, "step-3")).toMatchObject({ file: "out.txt +2", costMicros: 61 });
  });

  it("adds an image step's Gemini cost to it", () => {
    const m = runMap([started(0, 2, "image_generate"), usage(1, { job: "image", step: 2, costMicros: 67_000 }), finished(1, 2, 1000)], T0);
    expect(byId(m, "step-2")).toMatchObject({ costMicros: 67_000 });
  });
});

describe("edgePath", () => {
  it("curves along a lane through the midpoint", () =>
    expect(edgePath({ x: 222, y: 148 }, { x: 246, y: 148 })).toBe("M222 148 C234 148, 234 148, 246 148"));
  it("curves across lanes through the vertical midpoint", () =>
    expect(edgePath({ x: 564, y: 184 }, { x: 614, y: 352 }, true)).toBe("M564 184 C564 268, 614 268, 614 352"));
});

describe("timeShares", () => {
  const events = [
    usage(0, { ms: 60_000, costMicros: 600 }),
    started(60, 1, "delegate"),
    ev(60, { type: "helper.started", lane: 1, step: 1, agentId: "a2", agentName: "researcher", task: "t", model: "m" }),
    usage(61, { lane: 1, ms: 19_000, costMicros: 300 }),
    ev(80, { type: "helper.finished", lane: 1, step: 1, status: "done", summary: "", steps: 0, ms: 20_000, costMicros: 300 }),
    finished(80, 1, 20_000),
    started(80, 2, "sandbox_run"),
    usage(95, { job: "sandbox", costMicros: 100 }),
    finished(95, 2, 15_000),
    ev(95, { type: "approval.requested", step: 3, call: call("w", "github_comment"), title: "?", expiresAt: at(7200) }),
    ev(100, { type: "approval.settled", step: 3, decision: "approved", by: "bea" }),
  ];

  it("splits the time between thinking, helpers, tools and waiting", () =>
    expect(timeShares([events], "time").map((s) => [s.key, s.pct])).toEqual([["thinking", 60], ["helpers", 20], ["tools", 15], ["waiting", 5]]));

  it("splits the cost the same way, leaving out what cost nothing", () =>
    expect(timeShares([events], "cost").map((s) => [s.key, s.pct])).toEqual([["thinking", 60], ["helpers", 30], ["tools", 10]]));

  it("counts an image's cost as a tool's", () => {
    const drew = [usage(0, { ms: 1000, costMicros: 3000 }), started(1, 1, "image_generate"), usage(2, { job: "image", step: 1, costMicros: 67_000 }), finished(2, 1, 1000)];
    expect(timeShares([drew], "cost").map((s) => [s.key, s.pct])).toEqual([["thinking", 4], ["tools", 96]]);
  });

  it("rounds to whole percents that still add up to 100", () => {
    const thirds = [usage(0, { ms: 1000 }), started(1, 1, "a"), finished(2, 1, 1000), ev(2, { type: "helper.finished", lane: 1, step: 9, status: "done", summary: "", steps: 0, ms: 1000, costMicros: 0 })];
    expect(timeShares([thirds], "time").map((s) => s.pct)).toEqual([34, 33, 33]);
  });

  it("adds up several turns, timing each approval within its own turn", () => {
    const asked = (s: number) => ev(s, { type: "approval.requested", step: 1, call: call("w", "github_comment"), title: "?", expiresAt: at(7200) });
    const settled = (s: number) => ev(s, { type: "approval.settled", step: 1, decision: "approved", by: "bea" });
    const first = [usage(0, { ms: 1000 }), asked(1), settled(2)];
    const second = [asked(10), usage(11, { ms: 2000 }), settled(13)];
    expect(timeShares([first, second], "time").map((s) => [s.key, s.pct])).toEqual([["thinking", 43], ["waiting", 57]]);
  });
});
