/** Cumulative layout shift, as browsers score it: shifts right after the user's own input don't count. */
export function clsFrom(entries: { value: number; hadRecentInput: boolean }[]): number {
  return entries.filter((e) => !e.hadRecentInput).reduce((sum, e) => sum + e.value, 0);
}

