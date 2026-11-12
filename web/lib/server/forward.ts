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
  ["PATCH", "/rooms/:x/chats/:x"],
  ["PATCH", "/rooms/:x/chats/:x/prefs"],
  ["POST", "/rooms/:x/leave"],
  ["POST", "/rooms/:x/archive"],
  ["POST", "/rooms/:x/threads"],
  ["PATCH", "/rooms/:x/threads/:x"],
  ["PUT", "/rooms/:x/budget"],
  ["PUT", "/rooms/:x/model"],
  ["POST", "/runs/:x/stream-ticket"],
  ["POST", "/runs/:x/approvals/:x"],
  ["GET", "/rooms/:x/connections"],
  ["GET", "/rooms/:x/connections/github/installations"],
  ["PUT", "/rooms/:x/connections/github"],
  ["DELETE", "/rooms/:x/connections/github"],
  ["POST", "/rooms/:x/connections/github/sign-in"],
  ["PUT", "/rooms/:x/approval-timeout"],
  ["GET", "/rooms/:x/audit"],
  ["GET", "/rooms/:x/files"],
  ["POST", "/rooms/:x/files/uploads"],
  ["PUT", "/rooms/:x/files"],
  ["GET", "/rooms/:x/files/download"],
  ["DELETE", "/rooms/:x/files"],
  ["PUT", "/rooms/:x/sandbox"],
  ["GET", "/oauth/requests/:x"],
  ["POST", "/oauth/requests/:x/decision"],
  ["GET", "/me/apps"],
  ["DELETE", "/me/apps/:x"],
  ["POST", "/rooms/:x/connections/mcp"],
  ["POST", "/rooms/:x/connections/mcp/:x/reconnect"],
  ["POST", "/rooms/:x/connections/mcp/:x/refresh"],
  ["DELETE", "/rooms/:x/connections/mcp/:x"],
  ["GET", "/rooms/:x/agents"],
  ["POST", "/rooms/:x/agents"],
  ["PATCH", "/rooms/:x/agents/:x"],
  ["DELETE", "/rooms/:x/agents/:x"],
  ["POST", "/rooms/:x/agents/:x/copy"],
  ["GET", "/rooms/:x/memory"],
  ["PATCH", "/rooms/:x/memory/:x"],
  ["DELETE", "/rooms/:x/memory/:x"],
  ["GET", "/rooms/:x/schedules"],
  ["POST", "/rooms/:x/schedules"],
  ["PATCH", "/rooms/:x/schedules/:x"],
  ["DELETE", "/rooms/:x/schedules/:x"],
  ["PUT", "/rooms/:x/timezone"],
  ["GET", "/push/key"],
  ["PUT", "/me/push"],
  ["DELETE", "/me/push/:x"],
  ["POST", "/rooms/:x/voice/sessions"],
  ["POST", "/rooms/:x/voice/sessions/:x/done"],
  ["POST", "/rooms/:x/speech"],
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
