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

/** Fresh means valid for more than `skewMs` longer, so a request never leaves with a token that expires in flight. */
export function isFresh(token: string | undefined, nowMs: number = Date.now(), skewMs = 60_000): boolean {
  const exp = token ? jwtClaims(token)?.exp : undefined;
  return typeof exp === "number" && exp * 1000 - nowMs > skewMs;
}
