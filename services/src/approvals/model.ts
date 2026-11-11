import { ValidationError } from "../lib/errors.js";
import type { ApprovalStatus } from "../threads/types.js";

/** What the model is told when a write step was cut short after it may already have reached `place`. */
export const unsure = (place: string) =>
  `This write may or may not have happened (the step was interrupted). Check ${place} before trying again.`;

export const SKIP_NOTE = (title: string) => `\n\n(Skipped because no one approved in time: ${title})`;
export const deniedResult = (by: string) => `Denied by ${by}. Don't try this again unless someone asks.`;
export const expiredResult = (sec: number) => `Skipped: no one approved this within ${formatWait(sec)}.`;

/** Why a decision lost: someone decided first, the wait ran out, or the run was stopped. */
export function conflictCopy(item: { status: ApprovalStatus; by?: string }): string {
  switch (item.status) {
    case "approved":
      return `Already approved by ${item.by}.`;
    case "denied":
      return `Already denied by ${item.by}.`;
    case "cancelled":
      return "This run was stopped.";
    // Still pending means the condition failed on the expiry time.
    case "pending":
    case "expired":
      return "This approval expired.";
  }
}

export function formatWait(sec: number): string {
  if (sec < 60) return "under a minute";
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

export function timeoutMinutes(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 5 || raw > 1440) {
    throw new ValidationError("The approval timeout is 5 to 1440 minutes.");
  }
  return raw;
}
