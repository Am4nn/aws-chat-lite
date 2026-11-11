import { budgetText } from "../budget/model.js";
import type { RunEndStatus } from "../threads/types.js";

const RUN_MAX_MS = 7_200_000;
const RUN_MAX_STEPS = 200;
/** The execution timeout (130 min) plus a margin for a step still finishing as it hits: a run this old can't still write. */
export const DEAD_AFTER_MS = 8_100_000;
export const DEAD_REASON = "The run stopped responding.";

export const eventSk = (seq: number) => `EV#${String(seq).padStart(10, "0")}`;

type RunState = {
  stopRequestedBy?: string;
  steps: number;
  startedAtMs: number;
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
  if (nowMs - s.startedAtMs > RUN_MAX_MS) return { status: "failed", reason: `Time limit reached (${RUN_MAX_MS / 3_600_000} hours).` };
  return null;
}
