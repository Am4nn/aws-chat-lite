export const inviteUrl = (origin: string, code: string) => `${origin}/invite/${code}`;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Time left on a link, in the largest whole unit (rounded down, but never shown as zero while it still works). */
export function expiresIn(expiresAtSec: number, nowSec: number): string {
  const left = expiresAtSec - nowSec;
  if (left <= 0) return "expired";
  if (left >= 86400) return plural(Math.floor(left / 86400), "day");
  if (left >= 3600) return plural(Math.floor(left / 3600), "hour");
  return plural(Math.max(1, Math.floor(left / 60)), "minute");
}
