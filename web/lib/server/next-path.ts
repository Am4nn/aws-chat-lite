/**
 * The `?next=` destination after login or a token refresh. Only a path on this site is accepted, which blocks
 * open redirects such as `//evil.com`, and never an auth page, which would loop.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (raw.startsWith("/bff/") || raw === "/login" || raw.startsWith("/login?")) return "/";
  return raw;
}
