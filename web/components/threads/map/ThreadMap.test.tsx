// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRunEvent, emptyRun } from "@/lib/client/run";
import type { Message, RunEvent, ThreadSummary } from "@/lib/types";
import { ThreadMap } from "./RunMap";

const streams = vi.hoisted(() => ({ byRun: {} as Record<string, RunEvent[]>, views: new WeakMap<RunEvent[], unknown>() }));
// Like the real stream, a run's view keeps its identity until a new event arrives.
const NO_EVENTS: RunEvent[] = [];
vi.mock("@/lib/client/useRunStream", () => ({
  useRunStream: (runId: string) => {
    const events = streams.byRun[runId] ?? NO_EVENTS;
    if (!streams.views.has(events)) streams.views.set(events, events.reduce(applyRunEvent, emptyRun()));
    return { run: streams.views.get(events), unavailable: false };
  },
}));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: () => undefined }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
beforeEach(() => { streams.byRun = {}; });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const T0 = Date.parse("2026-11-11T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (seq: number, s: number, body: Record<string, unknown>) => ({ seq, at: at(s), ...body }) as RunEvent;
const usage = (seq: number, s: number, ms: number, costMicros: number) =>
  ev(seq, s, { type: "usage", model: "m", job: "run", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros, ms });
/** A turn that only answers: thinking for 7 s. */
const answered = [
  ev(1, 0, { type: "run.started", pick: "auto", startedBy: "aman", agentName: "agent" }),
  ev(2, 1, { type: "text", text: "Sure.", turn: 1 }),
  usage(3, 7, 7000, 5000),
  ev(4, 7, { type: "run.finished", status: "done", ms: 7000, steps: 0, costMicros: 5000 }),
];
/** A turn that searches once (2 s) after thinking for 2 s, then answers. */
const searched = [
  ev(1, 0, { type: "run.started", pick: "auto", startedBy: "aman", agentName: "agent" }),
  usage(2, 2, 2000, 20_000),
  ev(3, 2, { type: "step.started", step: 1, call: { id: "c1", name: "web_search", input: {} }, detail: "q" }),
  ev(4, 4, { type: "step.finished", step: 1, output: "found", ms: 2000, ok: true }),
  ev(5, 5, { type: "text", text: "Done.", turn: 2 }),
  usage(6, 5, 0, 0),
  ev(7, 5, { type: "run.finished", status: "done", ms: 5000, steps: 1, costMicros: 20_000 }),
];

const thread = { threadId: "t1", number: 1, status: "idle", runId: "r12" } as unknown as ThreadSummary;
/** A thread of `n` turns, each a prompt and the answer that names its run. */
const turns = (n: number, prompt = (i: number) => `prompt ${i}`) => Array.from({ length: n }, (_, i) => [
  { seq: 2 * i + 1, text: prompt(i + 1), authorId: "u1" },
  { seq: 2 * i + 2, text: "answer", authorId: "agent", agent: { runId: `r${i + 1}`, firstSeq: 2 * i + 1 } },
]).flat() as unknown as Message[];
const shownTurns = () => screen.getAllByRole("region", { name: /^Turn / });

describe("ThreadMap", () => {
  it("shows the newest turn first, each led by the message that started it", () => {
    render(<ThreadMap thread={{ ...thread, runId: "r3" }} messages={turns(3)} />);
    expect(shownTurns().map((t) => t.getAttribute("aria-label"))).toEqual(["Turn 3", "Turn 2", "Turn 1"]);
    expect(within(shownTurns()[0]).getByText("prompt 3")).toBeTruthy();
  });

  it("loads the latest 10 turns and offers the earlier ones below them", () => {
    render(<ThreadMap thread={thread} messages={turns(12)} />);
    expect(shownTurns()).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 earlier turns" }));
    expect(shownTurns().map((t) => t.getAttribute("aria-label")).slice(-2)).toEqual(["Turn 2", "Turn 1"]);
    expect(screen.queryByRole("button", { name: /earlier turns/ })).toBeNull();
  });

  it("scrolls to the turn a message's Map link names", () => {
    render(<ThreadMap thread={{ ...thread, runId: "r3" }} runId="r2" messages={turns(3)} />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.getElementById("run-r2")).not.toBeNull();
  });

  it("sums every turn into one breakdown at the top, not one per turn", () => {
    streams.byRun = { r1: answered, r2: searched };
    render(<ThreadMap thread={{ ...thread, runId: "r2" }} messages={turns(2)} />);
    const bars = screen.getAllByRole("img", { name: /thinking/ });
    expect(bars).toHaveLength(1);
    // Thinking 7 s + 2 s against 2 s of searching.
    expect(bars[0].getAttribute("aria-label")).toBe("thinking 82%, tools 18%");
    expect(screen.getByText(/^2 turns · 1 step$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "cost: $0.03" }));
    expect(bars[0].getAttribute("aria-label")).toBe("thinking 100%");
  });

  it("keeps a turn that only answered quiet: its answer, time and cost, without a step count or Replay", () => {
    streams.byRun = { r1: answered, r2: searched };
    render(<ThreadMap thread={{ ...thread, runId: "r2" }} messages={turns(2)} />);
    const [newest, trivial] = shownTurns();
    expect(within(trivial).getByRole("button", { name: /answer/ })).toBeTruthy();
    expect(within(trivial).getByText("0:07 · <$0.01")).toBeTruthy();
    expect(within(trivial).queryByRole("button", { name: "Replay this turn" })).toBeNull();
    expect(within(newest).getByText("1 step · 0:05 · $0.02")).toBeTruthy();
    expect(within(newest).getByRole("button", { name: "Replay this turn" })).toBeTruthy();
  });

  it("clamps a long prompt to three lines and expands it in place on request", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(52);
    render(<ThreadMap thread={{ ...thread, runId: "r1" }} messages={turns(1, () => "a very long prompt")} />);
    const more = screen.getByRole("button", { name: "more" });
    const prompt = screen.getByText("a very long prompt");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(prompt.className).toContain("max-h-");
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "less" }).getAttribute("aria-expanded")).toBe("true");
    expect(prompt.className).not.toContain("max-h-");
  });

  it("shows no more control on a prompt that fits", () => {
    render(<ThreadMap thread={{ ...thread, runId: "r1" }} messages={turns(1)} />);
    expect(screen.queryByRole("button", { name: "more" })).toBeNull();
  });
});
