import type { TranscribeResult } from "./eventstream";

/** `final`: the words Transcribe has settled. `partial`: its current guess at the words after them. */
export type LiveText = { final: string; partial: string };

/** Each partial result is a fresh guess at the same words, so it replaces the last one; a final one settles them. */
export function applyResults(s: LiveText, results: TranscribeResult[]): LiveText {
  return results.reduce((acc, r) => {
    const text = r.Alternatives[0]?.Transcript ?? "";
    return r.IsPartial ? { ...acc, partial: text } : { final: `${acc.final} ${text}`.trim(), partial: "" };
  }, s);
}

export const transcriptText = (s: LiveText) => `${s.final} ${s.partial}`.trim();
