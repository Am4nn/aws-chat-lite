import type { Budget } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatUsd(micros: number): string {
  if (micros > 0 && micros < 10_000) return "<$0.01";
  return `$${(micros / 1e6).toFixed(2)}`;
}

export const budgetFill = (b: Pick<Budget, "spentMicros" | "capMicros">) =>
  b.capMicros === 0 ? 100 : Math.min(100, (b.spentMicros / b.capMicros) * 100);

export function splitHeadline(text: string): { headline: string | null; body: string } {
  const i = text.indexOf("\n\n");
  if (i > 0 && i <= 120 && !text.slice(0, i).includes("\n")) return { headline: text.slice(0, i), body: text.slice(i + 2) };
  return { headline: null, body: text };
}

// A trailing partial word would flash and then change, so it waits for its space unless the text is final.
export function streamWords(text: string, final: boolean): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!final && words.length && !/\s$/.test(text)) words.pop();
  return words;
}
