import type { CheckResult } from "../report.js";

export type Outputs = Record<string, string>;
export type Stage = "local" | "aws";

/** Runs one check; any throw becomes a ❌ row instead of stopping the spike. */
export async function check(service: string, feature: string, fn: () => Promise<string | void>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const notes = (await fn()) ?? "";
    return { service, feature, ok: true, notes, ms: Date.now() - t0 };
  } catch (e) {
    return { service, feature, ok: false, notes: String((e as Error).message ?? e), ms: Date.now() - t0 };
  }
}

/** A probe that never answers must become a ❌ row, not a hung spike. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
