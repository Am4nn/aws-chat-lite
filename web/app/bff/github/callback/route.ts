import type { NextRequest } from "next/server";
import { callApi, idToken } from "@/lib/server/api";
import { isFresh } from "@/lib/server/jwt";
import { relativeRedirect } from "@/lib/server/respond";
import { githubCallbackTarget } from "@/lib/client/github";

/**
 * Where GitHub's sign-in returns the browser. The API finishes it only for the signed-in admin who started it, which
 * is what stops a link carrying someone else's code (OAuth CSRF) from offering their installations in this room.
 * The refresh cookie never reaches this path, so a stale session signs in again and the admin starts over.
 */
export async function GET(req: NextRequest) {
  const token = await idToken();
  if (!isFresh(token)) return relativeRedirect("/login");
  const q = req.nextUrl.searchParams;
  const res = await callApi("/github-flows/finish", token, {
    method: "POST",
    body: JSON.stringify({ state: q.get("state") ?? "", code: q.get("code") ?? undefined, error: q.get("error") ?? undefined }),
  });
  return relativeRedirect(githubCallbackTarget({ status: res.status, body: await res.json().catch(() => ({})) }));
}
