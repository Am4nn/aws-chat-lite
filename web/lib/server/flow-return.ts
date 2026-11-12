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
  const res = await callApi(apiPath, token, {
    method: "POST",
    body: JSON.stringify({ state: q.get("state") ?? "", code: q.get("code") ?? undefined, error: q.get("error") ?? undefined }),
  });
  return relativeRedirect(target({ status: res.status, body: await res.json().catch(() => ({})) }));
}

/** Back to the room with the result for its toast, or home when the API couldn't tell which room the flow was for. */
const back = (roomId: string | undefined, query: [string, string]) => `${roomId ? `/r/${roomId}` : "/"}?${new URLSearchParams([query])}`;
const failure = (body: Finished["body"]) => body.error ?? "Something went wrong.";

export const mcpTarget = ({ status, body }: Finished) =>
  back(body.roomId, status < 300 && body.connection ? ["mcp", body.connection.name] : ["mcpError", failure(body)]);

/** A GitHub sign-in comes back to pick repos. */
export const githubTarget = ({ status, body }: Finished) =>
  back(body.roomId, status < 300 ? ["github", "pick"] : ["githubError", failure(body)]);
