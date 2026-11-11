import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../threads/types.js";
import { finishRun } from "./finish.js";
import type { Run } from "./repo.js";

const fake = vi.hoisted(() => ({
  events: [] as RunEvent[],
  stored: {} as Record<string, unknown>,
  closed: [] as unknown[],
  pushed: [] as unknown[],
}));

vi.mock("./repo.js", () => ({
  runsRepo: () => ({
    allEvents: async () => fake.events,
    closeRun: async (_run: Run, opts: unknown) => {
      fake.closed.push(opts);
      return { result: "closed", endedAt: "2026-11-11T10:01:00.000Z" };
    },
    eventWriter: async () => ({ append: async (body: object) => ({ ...body, seq: 9, at: "now" }) }),
    getRun: async () => fake.stored,
  }),
}));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => ({ threadById: async () => undefined }) }));
vi.mock("../workspace/session.js", () => ({ closeSandbox: async () => {} }));
vi.mock("../live/broadcast.js", () => ({ broadcastToRoom: async () => {} }));
vi.mock("./notify.js", () => ({ notifyRun: async () => {} }));
vi.mock("../push/enqueue.js", () => ({ enqueuePush: async (job: unknown) => void fake.pushed.push(job) }));

const run: Run = {
  runId: "RUN", roomId: "R", threadId: "T", number: 7, status: "running", pick: "auto", pickBy: "default", model: "fake",
  startedBy: "aman", startedById: "u-aman", startedAt: "2026-11-11T10:00:00.000Z", deadAt: "2026-11-11T11:00:00.000Z",
  firstSeq: 1, seenSeq: 1, steps: 1, costMicros: 10,
};
const opts = { seenSeq: 1, force: false };
const at = (seq: number, body: object) => ({ seq, at: "now", ...body }) as RunEvent;

beforeEach(() => {
  fake.events = [at(1, { type: "text", text: "Here it is.", turn: 1 })];
  fake.stored = {};
  fake.closed = [];
  fake.pushed = [];
});

describe("finishRun", () => {
  it("tells the run's starter it finished, with the answer's first line", async () => {
    await finishRun(run, { status: "done" }, opts);
    expect(fake.pushed).toEqual([{
      kind: "run", roomId: "R", threadId: "T", number: 7, status: "done", summary: "Here it is.", userIds: ["u-aman"],
    }]);
  });

  it("tells the starter why a run failed", async () => {
    await finishRun(run, { status: "capped", reason: "The room's budget is used up." }, opts);
    expect(fake.pushed).toMatchObject([{ status: "capped", reason: "The room's budget is used up.", userIds: ["u-aman"] }]);
  });

  it("tells the starter who stopped their run, but not when they stopped it themselves", async () => {
    fake.stored = { stopRequestedBy: "bea" };
    await finishRun(run, { status: "stopped", reason: "Stopped by bea." }, opts);
    expect(fake.pushed).toMatchObject([{ status: "stopped", stoppedBy: "bea", userIds: ["u-aman"] }]);
    fake.pushed = [];
    fake.stored = { stopRequestedBy: "aman" };
    await finishRun(run, { status: "stopped", reason: "Stopped by aman." }, opts);
    expect(fake.pushed).toEqual([]);
  });

  it("sends nothing for a run from before starters' ids were kept", async () => {
    const { startedById: _, ...old } = run;
    await finishRun(old, { status: "done" }, opts);
    expect(fake.pushed).toEqual([]);
  });

  it("stores the images the run made on its answer", async () => {
    fake.events.push(at(2, { type: "step.finished", step: 1, output: "Saved", ms: 1, ok: true, image: { path: "images/7-1-fox.png", aspect: "1:1" } }));
    await finishRun(run, { status: "done" }, opts);
    expect(fake.closed).toMatchObject([{ images: [{ path: "images/7-1-fox.png", aspect: "1:1" }] }]);
  });
});
