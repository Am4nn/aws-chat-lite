import { isFresh } from "./jwt";

export type GateResult =
  | { type: "next" }
  | { type: "error"; status: 403 | 415; error: string }
  | { type: "redirect"; location: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const isPublic = (path: string) => path === "/login" || path.startsWith("/invite/") || path.startsWith("/bff/");

/**
 * CSRF defence for /bff/* on top of SameSite=Lax cookies, using the standard pair of checks:
 * the Origin header must be our own site (browsers always send it on cross-site writes and pages can't forge it),
 * and the body must be JSON (a cross-site HTML form can't send JSON without a CORS preflight, which we never answer).
 */
export function checkMutation(r: {
  method: string; origin: string | null; contentType: string | null; allowed: string[];
}): null | { status: 403 | 415; error: string } {
  if (SAFE_METHODS.has(r.method.toUpperCase())) return null;
  if (!r.origin || !r.allowed.includes(r.origin)) return { status: 403, error: "Cross-site request refused." };
  const type = (r.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Send JSON (content-type: application/json)." };
  return null;
}

/**
 * The decision made for every request before it reaches a page or route handler:
 * writes to /bff/* must pass the CSRF check, and a page without a fresh ID token is sent to the refresh endpoint,
 * the only path that receives the refresh cookie, which swaps it for a new token and comes back (or goes to /login).
 */
export function gate(r: {
  method: string; pathname: string; search: string; headers: Headers; idToken?: string; extraOrigins: string[]; now?: number;
}): GateResult {
  if (r.pathname.startsWith("/bff/")) {
    const host = r.headers.get("host");
    const proto = r.headers.get("x-forwarded-proto") ?? "http";
    const allowed = [...(host ? [`${proto}://${host}`] : []), ...r.extraOrigins];
    const bad = checkMutation({ method: r.method, origin: r.headers.get("origin"), contentType: r.headers.get("content-type"), allowed });
    if (bad) return { type: "error", ...bad };
  }
  if (isPublic(r.pathname) || isFresh(r.idToken, r.now)) return { type: "next" };
  return { type: "redirect", location: `/bff/auth/refresh?next=${encodeURIComponent(r.pathname + r.search)}` };
}
