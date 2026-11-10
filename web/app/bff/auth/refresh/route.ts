import { NextResponse, type NextRequest } from "next/server";
import { refresh } from "@/lib/server/cognito";
import { clearedCookies, REFRESH_COOKIE, sessionCookies } from "@/lib/server/cookies";
import { serverEnv } from "@/lib/server/env";
import { safeNext } from "@/lib/server/next-path";
import { jsonError, relativeRedirect, withCookies } from "@/lib/server/respond";

/**
 * The only path the refresh cookie is sent to. GET serves page loads whose ID token expired (the gate sends them
 * here with ?next=) and returns them to that page; POST serves client fetches that got a 401.
 */
async function renew(req: NextRequest) {
  const token = req.cookies.get(REFRESH_COOKIE)?.value;
  if (!token) return null;
  try {
    return sessionCookies(await refresh(token), serverEnv().secureCookies);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const cookies = await renew(req);
  if (cookies) return withCookies(relativeRedirect(next), cookies);
  return withCookies(relativeRedirect(`/login?next=${encodeURIComponent(next)}`), clearedCookies(serverEnv().secureCookies));
}

export async function POST(req: NextRequest) {
  const cookies = await renew(req);
  if (cookies) return withCookies(NextResponse.json({ ok: true }), cookies);
  return withCookies(jsonError(401, "Signed out."), clearedCookies(serverEnv().secureCookies));
}
