// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyRunEvent, emptyRun } from "@/lib/client/run";
import type { RunEvent } from "@/lib/types";
import { RunMap } from "./RunMap";
import { StepDetails } from "./StepDetails";
import { StepPick, type PickedStep } from "./stepPick";

const stream = vi.hoisted(() => ({ events: [] as RunEvent[] }));
vi.mock("@/lib/client/useRunStream", () => ({
  useRunStream: () => ({ run: stream.events.reduce(applyRunEvent, emptyRun()), unavailable: false }),
}));
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

function Harness() {
  const [picked, pick] = useState<PickedStep | null>(null);
  return (
    <StepPick.Provider value={{ picked, pick }}>
      <RunMap runId="run1" live={false} />
      {picked && <StepDetails {...picked} />}
    </StepPick.Provider>
  );
}

const details = () => within(screen.getByRole("region", { name: "Step details" }));

beforeAll(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("RunMap", () => {
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
    const nodes = ["aman asks", "web_search", "github_comment"].map((name) => screen.getByRole("button", { name: new RegExp(name) }));
    for (const node of nodes) expect(node.tabIndex).toBe(0);
  });
});
