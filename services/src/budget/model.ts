import { ValidationError } from "../lib/errors.js";
import type { Budget } from "../threads/types.js";

const DEFAULT_CAP_MICROS = 3_000_000;

/** Budgets run on the UTC month so every member's cap resets at the same moment. */
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

export function resetsAt(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, m!, 1)).toISOString();
}

/** The room's budget for `month`, from its META item (the cap) and its usage item for that month (the spend). */
export function budgetOf(month: string, meta?: Record<string, unknown>, usage?: Record<string, unknown>): Budget {
  return {
    spentMicros: Number(usage?.costMicros ?? 0), capMicros: Number(meta?.budgetCapMicros ?? DEFAULT_CAP_MICROS),
    capRev: Number(meta?.budgetCapRev ?? 0), month,
    resetsAt: resetsAt(month),
  };
}

/** A cap in dollars, $0 to $20, rounded to the cent, as micro-dollars. */
export function capFromUsd(raw: unknown): number {
  if (typeof raw !== "number" || !(raw >= 0 && raw <= 20)) {
    throw new ValidationError("The budget must be between $0 and $20.");
  }
  // toFixed first: 2.555 * 100 is 255.4999… in floating point.
  return Math.round(Number((raw * 100).toFixed(6))) * 10_000;
}

const monthLong = (d: Date) => d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });

export function budgetText(capMicros: number, month: string): string {
  const reset = new Date(resetsAt(month));
  const used = new Date(`${month}-01T00:00:00Z`);
  return `This room has used its $${(capMicros / 1_000_000).toFixed(2)} budget for ${monthLong(used)}. It resets on ${monthLong(reset)} 1 (00:00 UTC).`;
}
