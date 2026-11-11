import type dns from "node:dns";
import type { User } from "../../lib/auth.js";
import { FlowFailed } from "../../lib/errors.js";
import { roomUpdated } from "../../live/broadcast.js";
import type { McpConnection } from "../../threads/types.js";
import { guardedFetch } from "../client/fetch.js";
import { mcpRepo } from "../client/repo.js";
import { tokenKey } from "../client/seal.js";

/**
 * Connects the local test server to a room as `admin`, playing the browser's part: it opens the authorize URL, which
 * the test server answers at once with a redirect carrying the code, and finishes the flow with it. `lookup` lets a
 * host name the Lambdas use (host.docker.internal) reach the server on this machine.
 */
export async function connectTestServer(
  roomId: string,
  admin: User,
  { serverUrl, lookup, localHosts, name = "test" }: { serverUrl: string; lookup?: typeof dns.lookup; localHosts: string[]; name?: string },
): Promise<McpConnection> {
  const fetch = guardedFetch({ localHosts, lookup });
  const repo = mcpRepo({ fetch, hosts: localHosts, key: tokenKey, notifyRoom: roomUpdated });
  const [site] = (process.env.SITE_ORIGINS ?? "").split(",");
  const started = await repo.connect(admin, roomId, { name, url: serverUrl, redirectUri: `${site}/bff/mcp/callback` });
  if ("connection" in started) return started.connection;
  const back = new URL((await fetch(started.authorizeUrl)).headers.get("location") ?? "");
  const q = back.searchParams;
  try {
    const { connection } = await repo.finish(admin, { state: q.get("state"), code: q.get("code") ?? undefined, error: q.get("error") ?? undefined });
    return connection;
  } catch (e) {
    throw e instanceof FlowFailed ? e.error : e;
  }
}
