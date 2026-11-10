/**
 * The two login cookies. Both are httpOnly, so JavaScript in the page can never read a token.
 * - cl_id holds the Cognito ID token. It is sent with every request to the site and lives as long as the token.
 * - cl_refresh holds the refresh token. It is only ever sent to /bff/auth/*, where it is swapped for a new ID
 *   token, which keeps the long-lived credential off every other request.
 * SameSite=Lax lets other sites link to us (a top-level GET carries the cookie) but not POST with it.
 * Secure is on for https; plain-http local development would otherwise drop the cookies.
 */
export const ID_COOKIE = "cl_id";
export const REFRESH_COOKIE = "cl_refresh";
const REFRESH_PATH = "/bff/auth";
const REFRESH_MAX_AGE = 30 * 24 * 3600;

export type CookieSpec = {
  name: string;
  value: string;
  options: { httpOnly: true; secure: boolean; sameSite: "lax"; path: string; maxAge: number };
};

const spec = (name: string, value: string, path: string, maxAge: number, secure: boolean): CookieSpec =>
  ({ name, value, options: { httpOnly: true, secure, sameSite: "lax", path, maxAge } });

export function sessionCookies(t: { idToken: string; refreshToken?: string; expiresIn: number }, secure: boolean): CookieSpec[] {
  const cookies = [spec(ID_COOKIE, t.idToken, "/", t.expiresIn, secure)];
  if (t.refreshToken) cookies.push(spec(REFRESH_COOKIE, t.refreshToken, REFRESH_PATH, REFRESH_MAX_AGE, secure));
  return cookies;
}

/** A browser only replaces a cookie when both name and path match, so each is expired on its own path. */
export function clearedCookies(secure: boolean): CookieSpec[] {
  return [spec(ID_COOKIE, "", "/", 0, secure), spec(REFRESH_COOKIE, "", REFRESH_PATH, 0, secure)];
}
