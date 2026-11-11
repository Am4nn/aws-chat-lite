import { createHash } from "node:crypto";
import type { Tool, ToolEnv } from "../../tools/types.js";
import type { McpConnection, McpToolInfo } from "../../threads/types.js";
import { guardedFetch } from "./fetch.js";
import { TOOL_CALL_TIMEOUT_MS } from "./limits.js";
import { withFreshAuth } from "./oauth.js";
import { callRemoteTool } from "./remote.js";
import { NeedsAuth, type TokenStore } from "./types.js";
import { localHosts } from "./url.js";

/** Model providers take tool names of at most 64 characters from this set. */
const MAX_NAME = 64;
const PREFIX = "mcp__";

const needsReconnecting = (name: string) => `${name} needs reconnecting. An admin can reconnect it in the room panel.`;

/**
 * `mcp__<server>__<tool>`. A name cut to fit keeps a hash of the tool's own name, so two long names that start alike
 * stay apart.
 */
export function mcpToolName(server: string, tool: string): string {
  const name = `${PREFIX}${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  if (name.length <= MAX_NAME) return name;
  const hash = createHash("sha256").update(tool).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_NAME - 9)}_${hash}`;
}

/** The connection a tool's name points at. A server's name holds no underscores, so the first `__` ends it. */
export const mcpServerOf = (toolName: string) => toolName.slice(PREFIX.length).split("__")[0];

/**
 * One of a room's remote tools, as the agent sees it. Its read-only label comes from the snapshot an admin saw when
 * connecting, so a server can't later turn a write into a read that skips the approval.
 */
export function mcpTool(roomId: string, conn: McpConnection, info: McpToolInfo): Tool {
  return {
    spec: { name: mcpToolName(conn.name, info.name), description: `${conn.name} (MCP): ${info.description}`, inputSchema: info.inputSchema },
    kind: "mcp",
    write: !info.readOnly,
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
 * back as the tool's failed output, so the model can tell the thread; a sign-in only an admin can fix says so.
 */
export function mcpCaller(connections: () => Connections): ToolEnv["mcpCall"] {
  return async ({ roomId, name }, tool, input) => {
    const repo = connections();
    const conn = await repo.get(roomId, name);
    if (!conn) return { ok: false, output: `This room has no MCP server called ${name}.` };
    const f = guardedFetch({ localHosts: localHosts(), timeoutMs: TOOL_CALL_TIMEOUT_MS });
    const call = (bearer?: string) => callRemoteTool(conn.url, bearer, tool, input, f);
    try {
      return await (conn.auth === "oauth" ? withFreshAuth(repo.tokenStore(roomId, name), f, call) : call());
    } catch (e) {
      if (e instanceof NeedsAuth) return { ok: false, output: needsReconnecting(name) };
      return { ok: false, output: `${name} didn't answer: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
}
