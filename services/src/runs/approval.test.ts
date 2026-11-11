import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../threads/types.js";
import { requestApproval } from "./approval.js";
import type { RoutedRun } from "./steps.js";

const fake = vi.hoisted(() => ({ events: [] as RunEvent[], pushed: [] as unknown[] }));

vi.mock("../approvals/repo.js", () => ({
  approvalsRepo: () => ({
    open: async (a: Record<string, unknown>) => ({ ...a, status: "pending" }),
    cancel: async () => undefined,
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
vi.mock("../push/enqueue.js", () => ({ enqueuePush: async (job: unknown) => void fake.pushed.push(job) }));

const run = { runId: "RUN", roomId: "R", threadId: "T", number: 7 } as RoutedRun;
const call = { id: "c1", name: "github_comment", input: { number: 1 } };
const gate = { timeoutSec: 600, title: "Comment on #1 in fake-org/playground?", input: { number: 1, repo: "fake-org/playground" } };

beforeEach(() => {
  fake.events = [];
  fake.pushed = [];
});

describe("requestApproval", () => {
  it("tells the room once, the first time the approval is logged", async () => {
    await requestApproval(run, call, 3, gate, "cb");
    await requestApproval(run, call, 3, gate, "cb");
    expect(fake.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(fake.pushed).toEqual([{ kind: "approval", roomId: "R", threadId: "T", number: 7, runId: "RUN", step: 3, title: gate.title }]);
  });
});
