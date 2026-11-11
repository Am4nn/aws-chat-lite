import { NextResponse } from "next/server";
import { authErrorMessage, signIn, signUp } from "@/lib/server/cognito";
import { sessionCookies } from "@/lib/server/cookies";
import { serverEnv } from "@/lib/server/env";
import { jsonError, readJson, str, withCookies } from "@/lib/server/respond";

// Mentions use these names: @agent asks the room's agent and @everyone tells the whole room. The PreSignUp trigger is
// the real guard; this check only saves a round trip to Cognito.
const RESERVED = new Set(["agent", "everyone"]);

/**
 * Creates the account. When Cognito confirms it straight away the user is also signed in; otherwise Cognito
 * emailed a code and the client continues with /bff/auth/confirm.
 */
export async function POST(req: Request) {
  const b = await readJson(req);
  const env = serverEnv();
  const [username, password, email] = [str(b.username), str(b.password), str(b.email)];
  if (!username || !password) return jsonError(400, "Username and password are required.");
  if (RESERVED.has(username.trim().toLowerCase())) return jsonError(400, "That username is reserved.");
  if (env.emailSignup && !email) return jsonError(400, "Email is required.");
  try {
    const r = await signUp(username, password, env.emailSignup ? email : undefined);
    if (!r.confirmed) return NextResponse.json({ confirmed: false, sentTo: r.sentTo ?? "" });
    return withCookies(NextResponse.json({ confirmed: true }), sessionCookies(await signIn(username, password), env.secureCookies));
  } catch (e) {
    return jsonError(400, authErrorMessage(e));
  }
}
