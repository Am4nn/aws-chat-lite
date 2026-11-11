import { budgetText } from "../budget/model.js";
import type { RunEndStatus } from "../threads/types.js";

const RUN_MAX_MS = 7_200_000;
const RUN_MAX_STEPS = 200;
/** Slightly over the execution timeout: a run this old can no longer be alive. */
export const DEAD_AFTER_MS = 7_800_000;

export const eventSk = (seq: number) => `EV#${String(seq).padStart(10, "0")}`;

type RunState = {
  stopRequestedBy?: string;
  steps: number;
  startedAtMs: number;
  /** Time spent waiting for approvals, which doesn't count toward the run's time limit. */
  pausedMs?: number;
  spentMicros: number;
  capMicros: number;
  month: string;
};

export const stoppedBy = (username: string) => ({ status: "stopped" as const, reason: `Stopped by ${username}.` });

/** Why a run must end now, or null to keep going. A member's stop outranks the automatic limits. */
export function endReason(s: RunState, nowMs: number): { status: RunEndStatus; reason: string } | null {
  if (s.stopRequestedBy) return stoppedBy(s.stopRequestedBy);
  if (s.spentMicros >= s.capMicros) return { status: "capped", reason: budgetText(s.capMicros, s.month) };
  if (s.steps >= RUN_MAX_STEPS) return { status: "failed", reason: `Step limit reached (${RUN_MAX_STEPS} steps).` };
  if (nowMs - s.startedAtMs - (s.pausedMs ?? 0) > RUN_MAX_MS) return { status: "failed", reason: "Time limit reached (2 hours)." };
  return null;
}
