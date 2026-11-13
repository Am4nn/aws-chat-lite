import type { Tool, ToolEnv } from "../../tools/types.js";
import type { McpConnection, McpToolInfo } from "../../threads/types.js";
import { guardedFetch } from "./fetch.js";
import { TOOL_CALL_TIMEOUT_MS } from "./limits.js";
import { needsReconnecting, noSuchServer, remoteFailure } from "./messages.js";
import { mcpToolName } from "./names.js";
import { withFreshAuth } from "./oauth.js";
import { callRemoteTool } from "./remote.js";
import { NeedsAuth, type TokenStore } from "./types.js";
import { localHosts } from "./url.js";

/**
 * One of a room's remote tools, as the agent sees it. Its read-only and destructive labels come from the snapshot an
 * admin saw when connecting, so a server can't later turn a write into a read that skips the approval. A snapshot from
 * before destructive hints were kept counts every write as destructive.
 */
export function mcpTool(roomId: string, conn: McpConnection, info: McpToolInfo): Tool {
  return {
    spec: { name: mcpToolName(conn.name, info.name), description: `${conn.name} (MCP): ${info.description}`, inputSchema: info.inputSchema },
    kind: "mcp",
    write: !info.readOnly,
    destructive: !info.readOnly && info.destructive !== false,
    detail: () => `${conn.name} · ${info.name}`,
    check(input) {
      if (conn.status === "needs_auth") return needsReconnecting(conn.name);
      return typeof input === "object" && input !== null && !Array.isArray(input) ? null : `Give ${info.name} an object.`;
    },
    ask: () => `Run ${info.name} on ${conn.name}?`,
    run: (input, env) => env.mcpCall({ roomId, name: conn.name }, info.name, input),
  };
}

type Connections = {
  get(roomId: string, name: string): Promise<McpConnection | null>;
  tokenStore(roomId: string, name: string): TokenStore;
};

/**
 * Calls a room's remote tool with the room's own sign-in, refreshing it when it runs out. Whatever goes wrong comes
 * back as the tool's failed output, in one short line, so the model can tell the thread; a sign-in only an admin can
 * fix says so.
 */
export function mcpCaller(connections: () => Connections): ToolEnv["mcpCall"] {
  return async ({ roomId, name }, tool, input) => {
    const repo = connections();
    const conn = await repo.get(roomId, name);
    if (!conn) return { ok: false, output: noSuchServer(name) };
    const f = guardedFetch({ localHosts: localHosts(), timeoutMs: TOOL_CALL_TIMEOUT_MS });
    const call = (bearer?: string) => callRemoteTool(conn.url, bearer, tool, input, f);
    try {
      return await (conn.auth === "oauth" ? withFreshAuth(repo.tokenStore(roomId, name), f, call) : call());
    } catch (e) {
      if (e instanceof NeedsAuth) return { ok: false, output: needsReconnecting(name) };
      return { ok: false, output: remoteFailure(name, e) };
    }
  };
}
