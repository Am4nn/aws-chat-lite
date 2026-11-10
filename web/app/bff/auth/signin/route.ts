import { NextResponse } from "next/server";
import { authErrorMessage, signIn } from "@/lib/server/cognito";
import { sessionCookies } from "@/lib/server/cookies";
import { serverEnv } from "@/lib/server/env";
import { jsonError, readJson, str, withCookies } from "@/lib/server/respond";

export async function POST(req: Request) {
  const b = await readJson(req);
  const [username, password] = [str(b.username), str(b.password)];
  if (!username || !password) return jsonError(400, "Username and password are required.");
  try {
    const tokens = await signIn(username, password);
    return withCookies(NextResponse.json({ ok: true }), sessionCookies(tokens, serverEnv().secureCookies));
  } catch (e) {
    return jsonError(400, authErrorMessage(e));
  }
}
