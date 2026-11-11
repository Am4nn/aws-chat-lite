/** Cumulative layout shift, as browsers score it: shifts right after the user's own input don't count. */
export function clsFrom(entries: { value: number; hadRecentInput: boolean }[]): number {
  return entries.filter((e) => !e.hadRecentInput).reduce((sum, e) => sum + e.value, 0);
}


/** Distinct numbers with no hole between the smallest and the largest. */
export function gapless(numbers: number[]): boolean {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.length > 0 && sorted.every((n, i) => n === sorted[0] + i);
}

const words = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether an answer sampled from the screen as it streamed never showed a word the stored answer doesn't have at that
 * place, and ended exactly on it. Line breaks render differently while streaming and once stored, so spacing is
 * compared loosely.
 */
export function streamedExactly(samples: string[], stored: string): boolean {
  const want = words(stored);
  return samples.length > 0 && samples.every((s) => want.startsWith(words(s))) && words(samples.at(-1)!) === want;
}
