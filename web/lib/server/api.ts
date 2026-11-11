import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ID_COOKIE } from "./cookies";
import { serverEnv } from "./env";
import { PATH_HEADER, safeNext } from "./next-path";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function idToken(): Promise<string | undefined> {
  return (await cookies()).get(ID_COOKIE)?.value;
}

/** A call to the HTTP API, authenticated with the caller's ID token when there is one. */
export function callApi(path: string, token: string | undefined, init: { method?: string; body?: string } = {}) {
  return fetch(`${serverEnv().apiUrl}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    cache: "no-store",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
}

/**
 * For server components: calls the API as the signed-in user and returns the JSON body.
 * A 401 means the token was rejected (for example after the user pool was reset), so the user signs in again and
 * then comes back to the page they were on.
 * A room's layout and its page both need the room view and me. Next doesn't dedupe a fetch that carries an abort
 * signal, so React's cache() makes each path one call per request instead.
 */
const getJson = cache(async (path: string): Promise<unknown> => {
  const res = await callApi(path, await idToken());
  if (res.status === 401) redirect(`/login?next=${encodeURIComponent(safeNext((await headers()).get(PATH_HEADER)))}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
});

export const serverApi = <T>(path: string) => getJson(path) as Promise<T>;

/** Like serverApi, but a missing resource (404) is a normal state the page renders, not an error. */
export async function serverApiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await serverApi<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
