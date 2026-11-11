import { describe, expect, it } from "vitest";
import type { Message, ThreadStatus, ThreadSummary } from "../types";
import {
  applyThreadUpdate, groupThread, liveCount, mergeBudget, nextRunDeadline, runLabel, runMeta, settleDeadRuns, sidebarThreads, slugName,
  stateText, threadMeta,
} from "./threads";

const th = (o: Partial<ThreadSummary>): ThreadSummary => ({
  roomId: "r", threadId: "t1", number: 1, name: "n", status: "idle", rev: 1, steps: 0, costMicros: 0,
  createdBy: "u", lastActivityAt: "2026-11-11T10:00:00Z", archived: false, taint: [], ...o,
});

describe("thread list", () => {
  it("ignores a lower rev and upserts a new thread", () => {
    const list = applyThreadUpdate([th({ rev: 3, name: "new" })], th({ rev: 2, name: "old" }));
    expect(list[0].name).toBe("new");
    expect(applyThreadUpdate(list, th({ threadId: "t2" }))).toHaveLength(2);
    expect(applyThreadUpdate(list, th({ rev: 4, name: "newer" }))[0].name).toBe("newer");
  });

  it("hides archived and orders by activity", () => {
    const list = [
      th({ threadId: "a", lastActivityAt: "2026-11-10T00:00:00Z" }),
      th({ threadId: "b", lastActivityAt: "2026-11-11T00:00:00Z" }),
      th({ threadId: "c", archived: true }),
    ];
    expect(sidebarThreads(list, Date.parse("2026-11-11T12:00:00Z")).map((t) => t.threadId)).toEqual(["b", "a"]);
  });

  it("hides threads idle for 7 days", () => {
    const old = th({ lastActivityAt: "2026-11-01T00:00:00Z" });
    expect(sidebarThreads([old], Date.parse("2026-11-11T12:00:00Z"))).toEqual([]);
  });

  it("counts running threads", () => {
    expect(liveCount([th({ status: "running" }), th({ status: "done" })])).toBe(1);
  });
});

describe("dead runs", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  const at = (min: number) => new Date(now + min * 60_000).toISOString();

  it("reads a run still running past the server's deadAt as failed, however long ago it started", () => {
    const [dead, alive] = settleDeadRuns([
      th({ threadId: "a", status: "running", startedAt: at(-30), deadAt: at(-1) }),
      th({ threadId: "b", status: "running", startedAt: at(-300), deadAt: at(1) }),
    ], now);
    expect([dead.status, alive.status]).toEqual(["failed", "running"]);
    expect(runLabel(dead)).toBe("Failed");
    expect(threadMeta(dead, now).text).toBe("failed");
  });

  it("reads a waiting run past its deadAt as failed too, but not before", () => {
    const [dead, alive] = settleDeadRuns([th({ status: "waiting", deadAt: at(-1) }), th({ status: "waiting", deadAt: at(1) })], now);
    expect([dead.status, alive.status]).toEqual(["failed", "waiting"]);
    expect(nextRunDeadline([th({ status: "waiting", deadAt: at(3) })], now)).toBe(now + 3 * 60_000);
  });

  it("lets a dead run leave the live count and archive", () => {
    const list = settleDeadRuns([th({ status: "running", deadAt: at(-1), lastActivityAt: at(-8 * 24 * 60) })], now);
    expect(liveCount(list)).toBe(0);
    expect(sidebarThreads(list, now)).toEqual([]);
  });

  it("knows when the next live run reaches its deadAt", () => {
    const list = [
      th({ threadId: "a", status: "running", deadAt: at(-1) }),
      th({ threadId: "b", status: "running", deadAt: at(5) }),
      th({ threadId: "c", status: "running", deadAt: at(100) }),
      th({ threadId: "d", status: "running" }),
    ];
    expect(nextRunDeadline(list, now)).toBe(now + 5 * 60_000);
    expect(nextRunDeadline([th({ status: "done" })], now)).toBe(Infinity);
  });
});

describe("waiting on an approval", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  const waiting = th({ status: "waiting", steps: 2, startedAt: new Date(now - 64_000).toISOString(), lastActivityAt: "2026-11-01T00:00:00Z" });
  it("counts as live: in the live count, and listed however long it has been idle", () => {
    expect(liveCount([waiting])).toBe(1);
    expect(sidebarThreads([waiting], now)).toHaveLength(1);
  });
  it("reads needs you in the sidebar, Needs approval in the capsule, and keeps counting time", () => {
    expect(threadMeta(waiting, now)).toEqual({ text: "needs you", tone: "waiting" });
    expect(runLabel(waiting)).toBe("Needs approval");
    expect(stateText("waiting")).toBe("needs approval");
    expect(runMeta(waiting, now)).toBe("step 2 · 1:04");
  });
});

describe("mergeBudget", () => {
  const b = (month: string, spentMicros: number, capMicros = 3_000_000) => ({ month, spentMicros, capMicros, resetsAt: "" });
  it("never rolls spend back within a month, but takes the newest cap", () => {
    expect(mergeBudget(b("2026-11", 500), b("2026-11", 300, 5_000_000))).toEqual(b("2026-11", 500, 5_000_000));
    expect(mergeBudget(b("2026-11", 300), b("2026-11", 500))).toEqual(b("2026-11", 500));
  });
  it("starts over in a new month and ignores a late frame from the last one", () => {
    expect(mergeBudget(b("2026-11", 500), b("2026-12", 0))).toEqual(b("2026-12", 0));
    expect(mergeBudget(b("2026-12", 0), b("2026-11", 500))).toEqual(b("2026-12", 0));
  });
});

describe("stateText (a thread's state for screen readers)", () => {
  it("says the state in words, and nothing for a thread that never ran", () => {
    expect(["running", "done", "stopped", "failed", "capped", "idle"].map((s) => stateText(s as ThreadStatus)))
      .toEqual(["running", "done", "stopped", "failed", "budget reached", ""]);
  });
});

describe("threadMeta", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  it("shows step and elapsed while running", () => {
    const t = th({ status: "running", steps: 3, startedAt: new Date(now - 64_000).toISOString() });
    expect(threadMeta(t, now)).toEqual({ text: "step 3 · 1:04", tone: "live" });
  });
  it("shows the finish time on the same day", () => {
    expect(threadMeta(th({ status: "done", endedAt: "2026-11-11T14:05:00Z" }), now, "UTC")).toEqual({ text: "14:05", tone: "muted" });
  });
  it("shows the date on another day", () => {
    expect(threadMeta(th({ status: "done", endedAt: "2026-11-09T14:05:00Z" }), now, "UTC").text).toBe("Nov 9");
  });
  it("names capped, stopped and failed", () => {
    expect(threadMeta(th({ status: "capped" }), now).text).toBe("budget");
    expect(threadMeta(th({ status: "stopped" }), now).text).toBe("stopped");
    expect(threadMeta(th({ status: "failed" }), now).text).toBe("failed");
  });
});

describe("groupThread", () => {
  const msg = (seq: number, o: Partial<Message> = {}) => ({ seq, authorId: "u", text: String(seq), ...o }) as Message;
  const answer = (seq: number, firstSeq: number) =>
    msg(seq, { authorId: "agent", agent: { runId: "r", status: "done", steps: 1, costMicros: 0, ms: 1, model: "m", pick: "auto", firstSeq } });

  it("folds trigger, steers and answer into one run block", () => {
    const blocks = groupThread([msg(1), msg(2), answer(3, 1)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "run", trigger: { seq: 1 }, steers: [{ seq: 2 }], answer: { seq: 3 } });
  });

  it("keeps messages outside runs and builds a live run without an answer", () => {
    const blocks = groupThread([msg(1), answer(2, 1), msg(3), msg(4)], 3);
    expect(blocks.map((b) => b.kind)).toEqual(["run", "run"]);
    expect(blocks[1]).toMatchObject({ trigger: { seq: 3 }, steers: [{ seq: 4 }] });
    expect(blocks[1]).toMatchObject({ answer: undefined });
  });

  it("keeps the last run a block after it ends, until its answer arrives", () => {
    const blocks = groupThread([msg(1), answer(2, 1), msg(3)], 3);
    expect(blocks[1]).toMatchObject({ kind: "run", trigger: { seq: 3 }, answer: undefined });
    expect(groupThread([msg(1), answer(2, 1)], 1)).toHaveLength(1);
  });

  it("passes through plain messages", () => {
    expect(groupThread([msg(1)]).map((b) => b.kind)).toEqual(["message"]);
  });
});

describe("run status (header capsule and card)", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  const started = new Date(now - 64_000).toISOString();
  it("names the running step, or thinking before the first", () => {
    expect(runLabel(th({ status: "running", currentStep: "github.list_prs" }))).toBe("github.list_prs");
    expect(runLabel(th({ status: "running" }))).toBe("thinking");
  });
  it("names how a run ended", () => {
    expect(runLabel(th({ status: "done" }))).toBe("Done");
    expect(runLabel(th({ status: "stopped" }))).toBe("Stopped");
    expect(runLabel(th({ status: "failed" }))).toBe("Failed");
    expect(runLabel(th({ status: "capped" }))).toBe("Budget reached");
  });
  it("counts the current step and the time so far while running", () => {
    expect(runMeta(th({ status: "running", steps: 2, startedAt: started }), now)).toBe("step 2 · 1:04");
  });
  it("counts at least step 1 while thinking, so a live run never reads step 0", () => {
    expect(runMeta(th({ status: "running", steps: 0, startedAt: started }), now)).toBe("step 1 · 1:04");
  });
  it("totals the steps and the run's time after it ends", () => {
    const ended = th({ status: "done", steps: 3, startedAt: started, endedAt: new Date(now - 4_000).toISOString() });
    expect(runMeta(ended, now)).toBe("3 steps · 1:00");
    expect(runMeta({ ...ended, steps: 1 }, now)).toBe("1 step · 1:00");
  });
});

describe("slugName (a thread name as it's typed)", () => {
  it("lowercases and turns spaces into dashes", () => expect(slugName("PR Check")).toBe("pr-check"));
  it("drops what a name can't hold", () => expect(slugName("deploy_v2!?")).toBe("deployv2"));
  it("never doubles a dash, but keeps one being typed at the end", () => {
    expect(slugName("a  --b")).toBe("a-b");
    expect(slugName("pr ")).toBe("pr-");
  });
  it("stops at 32 characters", () => expect(slugName("x".repeat(40))).toHaveLength(32));
});
