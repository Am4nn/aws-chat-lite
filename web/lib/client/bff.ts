/**
 * Calls from the browser to the Next.js server's /bff/* routes. The httpOnly cookies ride along automatically.
 * When the ID token has expired, one silent refresh is attempted before giving up and sending the user to sign in.
 */
export async function bff<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const send = () => fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let res = await send();
  if (res.status === 401 && !path.startsWith("/bff/auth/")) {
    const refreshed = await fetch("/bff/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!refreshed.ok) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      throw new Error("Signed out.");
    }
    res = await send();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
  return body as T;
}
