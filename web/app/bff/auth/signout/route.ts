import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { revoke } from "@/lib/server/cognito";
import { clearedCookies, REFRESH_COOKIE } from "@/lib/server/cookies";
import { serverEnv } from "@/lib/server/env";
import { withCookies } from "@/lib/server/respond";

export async function POST() {
  const refreshToken = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (refreshToken) await revoke(refreshToken);
  return withCookies(NextResponse.json({ ok: true }), clearedCookies(serverEnv().secureCookies));
}
