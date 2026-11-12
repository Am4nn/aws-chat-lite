// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyRunEvent, emptyRun } from "@/lib/client/run";
import type { Message, RunEvent, ThreadSummary } from "@/lib/types";
import { ThreadMap } from "./RunMap";
import { StepDetails } from "./StepDetails";
import { StepPick, type PickedStep } from "./stepPick";

const stream = vi.hoisted(() => ({ events: [] as RunEvent[], views: new WeakMap<RunEvent[], unknown>() }));
// Like the real stream, a run's view keeps its identity until a new event arrives.
vi.mock("@/lib/client/useRunStream", () => ({
  useRunStream: () => {
    if (!stream.views.has(stream.events)) stream.views.set(stream.events, stream.events.reduce(applyRunEvent, emptyRun()));
    return { run: stream.views.get(stream.events), unavailable: false };
  },
}));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: () => undefined }) }));
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(async () => ({})), errorText: String }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => () => {} }));

const at = (s: number) => new Date(Date.parse("2026-11-11T10:00:00Z") + s * 1000).toISOString();
const ev = (seq: number, s: number, body: Record<string, unknown>) => ({ seq, at: at(s), ...body }) as RunEvent;
const call = { id: "c1", name: "web_search", input: { query: "rotation" } };
const searched = [
  ev(1, 0, { type: "run.started", pick: "auto", startedBy: "aman", agentName: "reviewer" }),
  ev(2, 2, { type: "usage", model: "m", job: "run", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 3000, ms: 2000 }),
  ev(3, 3, { type: "step.started", step: 1, call, detail: "rotation" }),
  ev(4, 5, { type: "step.finished", step: 1, output: "5 results", ms: 1800, ok: true }),
];
const gated = [
  ...searched,
  ev(5, 6, { type: "approval.requested", step: 2, call: { id: "c2", name: "github_comment", input: {} }, title: "Comment on #41?", expiresAt: at(7200) }),
];

const thread = { threadId: "t1", number: 1, status: "idle", runId: "run1" } as unknown as ThreadSummary;
const messages = [{ seq: 1, text: "check the rotation", authorId: "u1" }] as unknown as Message[];

function Harness() {
  const [picked, pick] = useState<PickedStep | null>(null);
  return (
    <StepPick.Provider value={{ picked, pick }}>
      <ThreadMap thread={thread} messages={messages} />
      {picked && <StepDetails {...picked} />}
    </StepPick.Provider>
  );
}

const details = () => within(screen.getByRole("region", { name: "Step details" }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("ThreadMap steps", () => {
  it("shows a clicked step's start, duration, tokens, cost and output", () => {
    stream.events = searched;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /web_search/ }));
    const d = details();
    for (const [label, value] of [["started", "0:03"], ["took", "1.8s"], ["tokens", "1.1k"], ["cost", "$0.003"]]) {
      expect(d.getByText(label).nextSibling?.textContent).toBe(value);
    }
    expect(d.getByText("5 results")).toBeTruthy();
  });

  it("offers Approve and Deny on a step waiting for a member", () => {
    stream.events = gated;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /github_comment/ }));
    expect(details().getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(details().getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("makes every step a button in the tab order", () => {
    stream.events = gated;
    render(<Harness />);
    const nodes = ["web_search", "github_comment"].map((name) => screen.getByRole("button", { name: new RegExp(name) }));
    for (const node of nodes) expect(node.tabIndex).toBe(0);
  });
});
