/**
 * Reads claims from a JWT without checking its signature. That is only safe for decisions that are harmless
 * when wrong, such as "is this token about to expire?". The HTTP API's JWT authorizer verifies every token for real.
 */
export function jwtClaims(token: string): { sub?: string; exp?: number } | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof c !== "object" || !c) return null;
    return { ...(c.sub ? { sub: String(c.sub) } : {}), ...(typeof c.exp === "number" ? { exp: c.exp } : {}) };
  } catch {
    return null;
  }
}

/** A token counts as fresh only with more than a minute left, so a request never leaves with one that expires in flight. */
const EXPIRY_MARGIN_MS = 60_000;

export function isFresh(token: string | undefined, nowMs: number = Date.now()): boolean {
  const exp = token ? jwtClaims(token)?.exp : undefined;
  return typeof exp === "number" && exp * 1000 - nowMs > EXPIRY_MARGIN_MS;
}
