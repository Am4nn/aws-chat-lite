import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../threads/types.js";
import { gateOf, requestApproval } from "./approval.js";
import type { RoutedRun } from "./steps.js";

const fake = vi.hoisted(() => ({
  events: [] as RunEvent[], pushed: [] as unknown[], taint: [] as string[], archived: false, cancelled: [] as unknown[][], woken: [] as string[],
}));

vi.mock("../approvals/repo.js", () => ({
  approvalsRepo: () => ({
    open: async (a: Record<string, unknown>) => ({ ...a, status: "pending" }),
    cancel: async (...args: unknown[]) => (fake.cancelled.push(args), "cb"),
  }),
}));
vi.mock("./repo.js", () => ({
  runsRepo: () => ({
    allEvents: async () => fake.events,
    eventWriter: async () => ({
      append: async (body: object) => {
        const event = { ...body, seq: fake.events.length + 1, at: "now" } as RunEvent;
        fake.events.push(event);
        return event;
      },
    }),
    markWaiting: async () => ({ thread: null }),
  }),
}));
vi.mock("./notify.js", () => ({ notifyRun: async () => {} }));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => ({ threadById: async () => ({ taint: fake.taint }) }) }));
vi.mock("./steps.js", async (actual) => ({
  ...await actual<object>(), limitsReached: async () => null, models: () => ({ servedBy: () => "fake" }),
  roomConnections: async (roomId: string) => ({ roomId, github: null, mcp: [], approvalTimeoutSec: 600 }),
}));
vi.mock("../push/enqueue.js", () => ({ enqueuePush: async (job: unknown) => void fake.pushed.push(job) }));
vi.mock("../approvals/decide.js", () => ({ wakeRun: async (callbackId: string) => void fake.woken.push(callbackId) }));
vi.mock("../budget/repo.js", () => ({ budgetRepo: () => ({ withArchived: async () => ({ archived: fake.archived }) }) }));

const run = { runId: "RUN", roomId: "R", threadId: "T", number: 7 } as RoutedRun;
const call = { id: "c1", name: "github_comment", input: { number: 1 } };
const gate = { timeoutSec: 600, title: "Comment on #1 in fake-org/playground?", input: { number: 1, repo: "fake-org/playground" } };

beforeEach(() => {
  fake.events = [];
  fake.pushed = [];
  fake.taint = [];
  fake.archived = false;
  fake.cancelled = [];
  fake.woken = [];
});

describe("gateOf", () => {
  const drawing = { ...run, model: "claude-sonnet-5-5", agent: { tools: ["images"] } } as RoutedRun;
  const image = { id: "c2", name: "image_generate", input: { prompt: "the launch plan" } };

  it("lets an image go without asking in a clean thread", async () => {
    expect(await gateOf(drawing, image, [])).toEqual({ asks: false });
  });

  it("asks before an image in a private thread, as it would before a web call", async () => {
    fake.taint = ["attachment"];
    expect(await gateOf(drawing, image, [])).toEqual({
      asks: true, timeoutSec: 600, title: 'Send "the launch plan" to Gemini for an image?', input: image.input,
    });
    fake.taint = [];
    expect(await gateOf(drawing, image, ["sandbox"])).toMatchObject({ asks: true });
  });
});

describe("requestApproval", () => {
  it("tells the room once, the first time the approval is logged", async () => {
    await requestApproval(run, call, 3, gate, "cb");
    await requestApproval(run, call, 3, gate, "cb");
    expect(fake.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(fake.pushed).toEqual([{ kind: "approval", roomId: "R", threadId: "T", number: 7, runId: "RUN", step: 3, title: gate.title }]);
    expect(fake.woken).toEqual([]);
  });

  it("wakes itself when the room was archived before it showed as waiting, which an archive's sweep would miss", async () => {
    fake.archived = true;
    await requestApproval(run, call, 3, gate, "cb");
    expect(fake.cancelled).toEqual([["RUN", 3, undefined]]);
    expect(fake.woken).toEqual(["cb"]);
  });
});
