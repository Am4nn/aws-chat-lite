const BASE = "http://site.invalid";

/**
 * The `?next=` destination after login or a token refresh. Only a path on this site is accepted, and never an auth
 * page, which would loop. The value is parsed the way a browser will parse it, because browsers drop tabs and line
 * breaks and treat `\` as `/`: a string check alone lets `/\t/evil.com` through, which the browser reads as
 * `//evil.com`. Whatever resolves to another origin falls back to `/`.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw?.startsWith("/")) return "/";
  const url = new URL(raw, BASE);
  if (url.origin !== BASE) return "/";
  const path = url.pathname + url.search + url.hash;
  if (path.startsWith("/bff/") || url.pathname === "/login") return "/";
  return path;
}
