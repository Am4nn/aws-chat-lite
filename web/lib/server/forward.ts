/**
 * The API calls the browser may make through /bff/api/*. An explicit allowlist keeps the BFF from becoming an open
 * proxy, and every path segment must be a plain id or name, which rules out path tricks like "..".
 * ":x" stands for one id or name segment.
 */
const ROUTES: [method: string, pattern: string][] = [
  ["GET", "/me"],
  ["GET", "/rooms"],
  ["POST", "/rooms"],
  ["GET", "/rooms/:x"],
  ["POST", "/rooms/:x/chats"],
  ["PATCH", "/rooms/:x/members/:x"],
  ["DELETE", "/rooms/:x/members/:x"],
  ["POST", "/rooms/:x/invite"],
  ["GET", "/rooms/:x/invite"],
  ["DELETE", "/rooms/:x/invite"],
  ["POST", "/invites/:x/accept"],
  ["POST", "/live/ticket"],
  ["GET", "/rooms/:x/chats/:x/messages"],
  ["POST", "/rooms/:x/attachments"],
  ["GET", "/rooms/:x/search"],
  ["PATCH", "/rooms/:x/chats/:x/prefs"],
  ["POST", "/rooms/:x/leave"],
  ["POST", "/rooms/:x/archive"],
];

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The API path to call, or null when this method and path aren't allowed. */
export function matchForward(method: string, segments: string[]): string | null {
  if (segments.length === 0 || !segments.every((s) => SEGMENT.test(s))) return null;
  const m = method.toUpperCase();
  const allowed = ROUTES.some(([rm, pattern]) => {
    const parts = pattern.slice(1).split("/");
    return rm === m && parts.length === segments.length && parts.every((p, i) => p === ":x" || p === segments[i]);
  });
  return allowed ? `/${segments.join("/")}` : null;
}
