import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import type { RunEvent } from "../threads/types.js";
import type { RoutedRun } from "./steps.js";
import { toolStep } from "./tool-step.js";

const runs = {
  allEvents: vi.fn(async (): Promise<RunEvent[]> => []),
  eventWriter: vi.fn(async () => ({ append: async (e: object) => ({ ...e, seq: 7, at: "2026-11-12T00:00:00.000Z" }) })),
  progress: vi.fn(async () => ({})),
  stepDone: vi.fn(async () => ({})),
  recorded: vi.fn(async () => undefined),
  callMarker: vi.fn(() => ({})),
  getRun: vi.fn(async () => ({ deadAt: "2026-11-12T02:00:00.000Z" })),
};
const audit = { record: vi.fn() };
vi.mock("./repo.js", () => ({ runsRepo: () => runs }));
vi.mock("./notify.js", () => ({ notifyRun: async () => {} }));
vi.mock("../audit/repo.js", () => ({ auditRepo: () => audit }));
vi.mock("../budget/repo.js", () => ({
  budgetRepo: () => ({
    withArchived: async () => ({ budget: { spentMicros: 0, capMicros: 3_000_000, month: "2026-11" }, archived: false }), spend: () => ({}),
  }),
}));
vi.mock("../connections/repo.js", () => ({ connectionsRepo: () => ({ get: async () => ({ github: null, mcp: [], approvalTimeoutSec: 7200 }) }) }));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => ({ addTaint: async () => {}, threadById: async () => ({ taint: [] }) }) }));
vi.mock("../images/step.js", async (actual) => ({
  ...await actual<object>(), imageDeps: () => ({}), generateImageStep: async () => ({ ok: true, output: "Saved images/1-1-1-cat.png." }),
}));
vi.mock("../workspace/session.js", () => ({ runSandbox: async () => ({ ok: true, output: "4", ms: 5 }) }));

process.env.MODEL_GATEWAY = "fake";

const run = {
  runId: "run1", roomId: "r1", threadId: "t1", number: 3, agentId: "agent", status: "running", pick: "sonnet", pickBy: "pick",
  model: "claude-sonnet-5-5", startedBy: "aman", startedById: "u-aman", startedAt: new Date().toISOString(), deadAt: "2026-11-12T02:00:00.000Z",
  firstSeq: 1, seenSeq: 1, steps: 0, costMicros: 0, agent: { ...BUILT_IN, tools: ["images", "sandbox"] }, others: [],
} satisfies RoutedRun;

beforeEach(() => vi.clearAllMocks());

describe("toolStep", () => {
  it.each([
    ["image_generate", { prompt: "a cat on a mat" }, 'Drawing "a cat on a mat"'],
    ["sandbox_run", { language: "python", code: "print(2 + 2)" }, "Running python: print(2 + 2)"],
  ])("logs %s in the room's audit, once per step, keyed by the step's start", async (name, input, detail) => {
    await toolStep(run, { id: "c1", name, input });
    expect(audit.record).toHaveBeenCalledWith("r1", {
      id: "run1#7", at: "2026-11-12T00:00:00.000Z", actor: "agent", kind: "tool", threadNumber: 3, tool: name, detail, agent: "agent",
    });
  });

  it("an image a member didn't approve is neither made nor logged as run", async () => {
    const settled = {
      runId: "run1", roomId: "r1", threadId: "t1", step: 1, call: { id: "c1", name: "image_generate", input: { prompt: "the plan" } },
      title: "t", callbackId: "cb", expiresAt: "2026-11-12T00:10:00.000Z", requestedAt: "2026-11-12T00:00:00.000Z", status: "denied" as const, by: "bea",
    };
    const appended: RunEvent[] = [];
    runs.eventWriter.mockResolvedValue({ append: async (e: object) => (appended.push(e as RunEvent), { ...e, seq: 7, at: "2026-11-12T00:00:00.000Z" }) });
    await toolStep(run, settled.call, settled);
    expect(audit.record).not.toHaveBeenCalled();
    expect(appended.find((e) => e.type === "step.finished")).toMatchObject({ ok: false, output: expect.stringMatching(/^Denied by bea\./) });
  });

  it("logs nothing for a tool the model was never offered", async () => {
    await toolStep(run, { id: "c1", name: "github_comment", input: {} });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
