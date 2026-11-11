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
  const body = req.method === "GET" ? undefined : await req.text();
  try {
    const res = await callApi(`${path}${req.nextUrl.search}`, token, { method: req.method, body });
    // A 204 may carry no body at all: the Response constructor throws on one.
    return new NextResponse(res.status === 204 ? null : (await res.text()) || "{}", {
      status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    // The deadline can pass before the answer starts or while its body streams in. Left uncaught, Next answers an
    // empty 500 and logs an unhandled rejection, because it can't rewrite the DOMException's read-only message.
    if (e instanceof DOMException && e.name === "TimeoutError") return jsonError(504, "chat-lite took too long to answer; try again.");
    throw e;
  }
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
