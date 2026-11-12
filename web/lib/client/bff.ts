export const DEFAULT_ERROR = "Something went wrong.";

/** An error whose message we wrote, so the user may see it. Any other error's text is the browser's or a library's. */
export class UserError extends Error {}

/**
 * Calls from the browser to the Next.js server's /bff/* routes. The httpOnly cookies ride along automatically.
 * When the ID token has expired, one silent refresh is attempted before giving up and sending the user to sign in.
 * The answer's error is the API's or the BFF's own, both of which send only messages they wrote.
 */
export class BffError extends UserError {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      throw new BffError(401, "Signed out.");
    }
    res = await send();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BffError(res.status, body.error ?? DEFAULT_ERROR);
  return body as T;
}

/** What to tell the user about a failure: our own message, or else `fallback`, with the real error kept in the console. */
export function errorText(e: unknown, fallback = DEFAULT_ERROR): string {
  if (e instanceof UserError) return e.message;
  console.error(e);
  return fallback;
}

/** A GET where "not found" is a normal answer (null). Any other failure still throws, so a blip isn't mistaken for "none". */
export async function bffOrNull<T>(path: string): Promise<T | null> {
  try {
    return await bff<T>(path);
  } catch (e) {
    if (e instanceof BffError && e.status === 404) return null;
    throw e;
  }
}
