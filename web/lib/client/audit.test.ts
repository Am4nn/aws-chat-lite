import { describe, it, expect } from "vitest";
import type { AuditEntry, ThreadSummary } from "../types";
import { auditLine, auditMayHaveChanged } from "./audit";

const entry = (over: Partial<AuditEntry>): AuditEntry =>
  ({ id: "e1", at: "2026-11-11T12:00:00Z", actor: "bea", kind: "asked", threadNumber: 4, detail: "", ...over });

describe("auditLine", () => {
  it("asked", () => expect(auditLine(entry({ kind: "asked", detail: "triage the open issues" })))
    .toBe('bea asked @agent in #4: "triage the open issues"'));
  it("tool", () => expect(auditLine(entry({ kind: "tool", actor: "agent", tool: "github_list" }))).toBe("@agent ran github_list in #4"));
  it("approved", () => expect(auditLine(entry({ kind: "approved", detail: "Comment on #3 in o/r?" })))
    .toBe('bea approved "Comment on #3 in o/r?" in #4'));
  it("denied", () => expect(auditLine(entry({ kind: "denied", detail: "Merge PR #2 in o/r (squash)?" })))
    .toBe('bea denied "Merge PR #2 in o/r (squash)?" in #4'));
  it("expired", () => expect(auditLine(entry({ kind: "expired", actor: "agent", detail: "Comment on #3 in o/r?" })))
    .toBe('No one approved "Comment on #3 in o/r?" in #4'));
  it("cancelled", () => expect(auditLine(entry({ kind: "cancelled", detail: "Comment on #3 in o/r?" })))
    .toBe('"Comment on #3 in o/r?" was cancelled (run stopped) in #4'));
  it("connected", () => expect(auditLine(entry({ kind: "connected", threadNumber: undefined, detail: "o/a, o/b" })))
    .toBe("bea connected o/a, o/b"));
  it("disconnected", () => expect(auditLine(entry({ kind: "disconnected", threadNumber: undefined, detail: "GitHub" })))
    .toBe("bea disconnected GitHub"));
  it("timeout", () => expect(auditLine(entry({ kind: "timeout", threadNumber: undefined, detail: "30 min" })))
    .toBe("bea set the approval timeout to 30 min"));
});

describe("auditMayHaveChanged", () => {
  const t = (o: Partial<ThreadSummary>): ThreadSummary => ({
    roomId: "r", threadId: "t1", number: 1, name: "n", status: "running", rev: 1, steps: 0, costMicros: 0, createdBy: "u",
    lastActivityAt: "2026-11-11T10:00:00Z", archived: false, taint: [], ...o,
  });
  it("is true when a run asks, settles, ends or finishes a tool", () => {
    expect(auditMayHaveChanged(t({}), t({ status: "waiting" }))).toBe(true);
    expect(auditMayHaveChanged(t({ status: "waiting" }), t({}))).toBe(true);
    expect(auditMayHaveChanged(t({}), t({ status: "done" }))).toBe(true);
    expect(auditMayHaveChanged(t({ currentStep: "github_list" }), t({}))).toBe(true);
    expect(auditMayHaveChanged(undefined, t({}))).toBe(true);
  });
  it("is false for a cost or a step starting", () => {
    expect(auditMayHaveChanged(t({}), t({ costMicros: 9 }))).toBe(false);
    expect(auditMayHaveChanged(t({}), t({ currentStep: "github_list" }))).toBe(false);
  });
});
