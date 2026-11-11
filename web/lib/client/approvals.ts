import type { ApprovalStatus, ThreadSummary } from "../types";
import { BffError, errorText } from "./bff";

/** Mirrors the server's wait copy, so the card and the model's "skipped" result name a timeout the same way. */
function formatWait(sec: number): string {
  if (sec < 60) return "under a minute";
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

/** How long an approval has left, for "expires in …". */
export const remaining = (expiresAt: string, nowMs: number) => formatWait(Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 1000)));

/** How an approval ended, in one line; I am "you". */
export function settledLine(a: { status: Exclude<ApprovalStatus, "pending">; by?: string }, meName?: string): string {
  const who = a.by === meName ? "you" : a.by;
  switch (a.status) {
    case "approved":
      return `Approved by ${who}`;
    case "denied":
      return `Denied by ${who}`;
    case "expired":
      return "Skipped: no one approved in time";
    case "cancelled":
      return "Cancelled: the run was stopped";
  }
}

/** The toast for a thread that just started waiting on a member, unless it's the one I have open. */
export function needsYouToast(
  prev: ThreadSummary[], next: ThreadSummary[], openThreadId: string | undefined,
): { number: number; title: string; detail: string } | null {
  const was = new Map(prev.map((t) => [t.threadId, t.status]));
  const t = next.find((x) => x.status === "waiting" && was.get(x.threadId) !== "waiting" && x.threadId !== openThreadId);
  return t ? { number: t.number, title: `#${t.name} needs you`, detail: t.approval?.title ?? "" } : null;
}

type Decision = "approve" | "deny";
/** My decision while it's on its way, or why it lost (someone else decided first, the wait ran out, the run stopped). */
export type LocalDecision = { decision: Decision } | { conflict: string } | null;

/**
 * Sends one decision. It shows at once, and a second click (or the other button) does nothing while it's out. A 409
 * means the approval is already settled, so the card stays shut with the server's reason until the run reports how;
 * any other refusal puts the buttons back.
 */
export function decider(send: (d: Decision) => Promise<void>, show: (s: LocalDecision) => void, tell: (text: string) => void) {
  let busy = false;
  return async (d: Decision) => {
    if (busy) return;
    busy = true;
    show({ decision: d });
    try {
      await send(d);
    } catch (e) {
      tell(errorText(e));
      if (e instanceof BffError && e.status === 409) {
        show({ conflict: e.message });
        return;
      }
      busy = false;
      show(null);
    }
  };
}
