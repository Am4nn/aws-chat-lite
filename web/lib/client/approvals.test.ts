import { describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../types";
import { BffError } from "./bff";
import { decider, needsYouToast, remaining, settledLine } from "./approvals";

const th = (o: Partial<ThreadSummary>): ThreadSummary => ({
  roomId: "r", threadId: "t1", number: 1, name: "pr-check", agentId: "agent", status: "running", rev: 1, steps: 0, costMicros: 0,
  createdBy: "u", lastActivityAt: "2026-11-11T10:00:00Z", archived: false, taint: [], ...o,
});

describe("remaining", () => {
  const now = Date.parse("2026-11-11T10:00:00Z");
  const at = (sec: number) => new Date(now + sec * 1000).toISOString();
  it("says how long is left in the approval timeout's own words", () => {
    expect(remaining(at(7_200), now)).toBe("2 h");
    expect(remaining(at(2_700), now)).toBe("45 min");
    expect(remaining(at(5_430), now)).toBe("1 h 30 min");
    expect(remaining(at(59), now)).toBe("under a minute");
    expect(remaining(at(-10), now)).toBe("under a minute");
  });
});

describe("settledLine", () => {
  it("says how each approval ended", () => {
    expect(settledLine({ status: "approved", by: "bea" })).toBe("Approved by bea");
    expect(settledLine({ status: "denied", by: "bea" })).toBe("Denied by bea");
    expect(settledLine({ status: "expired" })).toBe("Skipped: no one approved in time");
    expect(settledLine({ status: "cancelled", by: "bea" })).toBe("Cancelled: the run was stopped");
  });
  it("says when the run stopped before an approved call could run", () =>
    expect(settledLine({ status: "approved", by: "bea", stoppedFirst: true })).toBe("Approved by bea (run stopped first)"));
  it("calls me you", () => expect(settledLine({ status: "approved", by: "aman" }, "aman")).toBe("Approved by you"));
});

describe("needsYouToast", () => {
  const approval = { step: 2, title: "Comment on #4 in a/b?", expiresAt: "2026-11-11T12:00:00Z" };
  const waiting = th({ status: "waiting", approval, rev: 2 });

  it("fires when a thread I don't have open starts waiting on an approval", () => {
    expect(needsYouToast([th({})], [waiting], "other")).toEqual({ number: 1, title: "#pr-check needs you", detail: "Comment on #4 in a/b?" });
  });
  it("stays quiet for the open thread, one already waiting, or one that isn't waiting", () => {
    expect(needsYouToast([th({})], [waiting], "t1")).toBeNull();
    expect(needsYouToast([waiting], [{ ...waiting, rev: 3 }], undefined)).toBeNull();
    expect(needsYouToast([th({})], [th({ status: "done" })], undefined)).toBeNull();
  });
  it("fires for a thread that appears already waiting", () => {
    expect(needsYouToast([], [waiting], undefined)?.title).toBe("#pr-check needs you");
  });
});

describe("decider", () => {
  const setup = (send: () => Promise<void>) => {
    const states: unknown[] = [];
    const notes: string[] = [];
    const decide = decider(vi.fn(send), (s) => states.push(s), (t) => notes.push(t));
    return { decide, states, notes };
  };

  it("sends one decision, even on a double click, and shows it at once", async () => {
    const send = vi.fn(async () => {});
    const decide = decider(send, () => {}, () => {});
    await Promise.all([decide("approve"), decide("approve"), decide("deny")]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("approve");
  });

  it("a 409 keeps the card shut and says who won, until the run reports how it settled", async () => {
    const { decide, states, notes } = setup(async () => { throw new BffError(409, "Already approved by bea."); });
    await decide("deny");
    expect(states).toEqual([{ decision: "deny" }, { conflict: "Already approved by bea." }]);
    expect(notes).toEqual(["Already approved by bea."]);
    await decide("approve");
    expect(states).toHaveLength(2);
  });

  it("any other refusal puts the buttons back and says why", async () => {
    let fail = true;
    const { decide, states, notes } = setup(async () => { if (fail) throw new BffError(404, "Approval not found."); });
    await decide("approve");
    expect(states).toEqual([{ decision: "approve" }, null]);
    expect(notes).toEqual(["Approval not found."]);
    fail = false;
    await decide("approve");
    expect(states).toEqual([{ decision: "approve" }, null, { decision: "approve" }]);
  });
});
