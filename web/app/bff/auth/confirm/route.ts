import { NextResponse } from "next/server";
import { authErrorMessage, confirmSignUp, signIn } from "@/lib/server/cognito";
import { sessionCookies } from "@/lib/server/cookies";
import { serverEnv } from "@/lib/server/env";
import { jsonError, readJson, str, withCookies } from "@/lib/server/respond";

export async function POST(req: Request) {
  const b = await readJson(req);
  const [username, code, password] = [str(b.username), str(b.code), str(b.password)];
  if (!username || !code || !password) return jsonError(400, "Username, code and password are required.");
  try {
    await confirmSignUp(username, code);
    return withCookies(NextResponse.json({ ok: true }), sessionCookies(await signIn(username, password), serverEnv().secureCookies));
  } catch (e) {
    return jsonError(400, authErrorMessage(e));
  }
}
