import { NextResponse, type NextRequest } from "next/server";
import { callApi, idToken } from "@/lib/server/api";
import { matchForward } from "@/lib/server/forward";
import { jsonError } from "@/lib/server/respond";

/** Browser → /bff/api/<path> → HTTP API /<path>, with the httpOnly ID token attached as a Bearer token. */
async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const path = matchForward(req.method, (await params).path);
  if (!path) return jsonError(404, "No such route.");
  const token = await idToken();
  if (!token) return jsonError(401, "Not signed in.");
  const res = await callApi(`${path}${req.nextUrl.search}`, token, {
    method: req.method, body: req.method === "GET" ? undefined : await req.text(),
  });
  // A 204 must have no body (the Response constructor throws on one); every other answer is JSON, even an empty one.
  const body = res.status === 204 ? null : (await res.text()) || "{}";
  return new NextResponse(body, {
    status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
