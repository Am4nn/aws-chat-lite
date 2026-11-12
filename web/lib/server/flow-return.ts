import "server-only";
import type { NextRequest } from "next/server";
import { callApi, idToken } from "./api";
import { isFresh } from "./jwt";
import { relativeRedirect } from "./respond";

type Finished = { status: number; body: { roomId?: string; connection?: { name: string }; error?: string } };

/**
 * Where a sign-in started from a room (a remote MCP server's, or GitHub's) returns the browser. The API finishes the
 * flow only for the signed-in admin who started it, which is what stops a link carrying someone else's code (OAuth
 * CSRF) from acting in this room. The refresh cookie never reaches this path, so a stale session signs in again and
 * the admin starts over.
 */
export async function finishFlow(req: NextRequest, apiPath: string, target: (finished: Finished) => string) {
  const token = await idToken();
  if (!isFresh(token)) return relativeRedirect("/login");
  const q = req.nextUrl.searchParams;
  return relativeRedirect(target(await finish(apiPath, token, {
    state: q.get("state") ?? "", code: q.get("code") ?? undefined, error: q.get("error") ?? undefined,
  })));
}

/** Passing the BFF's own deadline lands like the gateway's 504, so both get the same message. */
async function finish(apiPath: string, token: string | undefined, answer: Record<string, string | undefined>): Promise<Finished> {
  try {
    const res = await callApi(apiPath, token, { method: "POST", body: JSON.stringify(answer) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") return { status: 504, body: {} };
    throw e;
  }
}

/** Back to the room with the result for its toast, or home when the API couldn't tell which room the flow was for. */
const back = (roomId: string | undefined, query: [string, string]) => `${roomId ? `/r/${roomId}` : "/"}?${new URLSearchParams([query])}`;

/**
 * The API's own errors carry a message. A bare 503 or 504 comes from API Gateway when the Lambda ran out of time
 * (or from the BFF's deadline), and the flow's slow step is the call out to the other side.
 */
const failure = ({ status, body }: Finished, slow: string) =>
  body.error ?? (status === 503 || status === 504 ? slow : "Something went wrong.");

export const mcpTarget = (finished: Finished) => {
  const { status, body } = finished;
  return back(body.roomId, status < 300 && body.connection
    ? ["mcp", body.connection.name]
    : ["mcpError", failure(finished, "The server took too long to answer. Try again.")]);
};

/** A GitHub sign-in comes back to pick repos. */
export const githubTarget = (finished: Finished) => back(finished.body.roomId, finished.status < 300
  ? ["github", "pick"]
  : ["githubError", failure(finished, "GitHub took too long to answer. Try Connect GitHub again.")]);
