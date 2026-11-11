import type { AuditEntry, ThreadSummary } from "../types";

/** One row of the room's activity log. */
export function auditLine(e: AuditEntry): string {
  const where = `in #${e.threadNumber}`;
  switch (e.kind) {
    case "asked":
      return `${e.actor} asked @agent ${where}: "${e.detail}"`;
    case "tool":
      return `@agent ran ${e.tool} ${where}`;
    case "approved":
    case "denied":
      return `${e.actor} ${e.kind} "${e.detail}" ${where}`;
    case "expired":
      return `No one approved "${e.detail}" ${where}`;
    case "cancelled":
      return `"${e.detail}" was cancelled (run stopped) ${where}`;
    case "connected":
      return `${e.actor} connected ${e.detail}`;
    case "disconnected":
      return `${e.actor} disconnected GitHub`;
    case "timeout":
      return `${e.actor} set the approval timeout to ${e.detail}`;
  }
}

/**
 * Whether a run's update may come with new log entries: it asked (the thread starts waiting), its approval settled
 * (waiting ends), it ended, or a tool it ran returned (the step clears). A cost or a step starting adds none.
 */
export const auditMayHaveChanged = (prev: ThreadSummary | undefined, next: ThreadSummary) =>
  prev?.status !== next.status || (!!prev.currentStep && !next.currentStep);
