import { UnauthorizedError, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { UserError } from "../../lib/errors.js";
import { cut } from "../../tools/cut.js";
import type { ToolResult } from "../../tools/types.js";
import type { McpToolInfo } from "../../threads/types.js";
import { MAX_DESCRIPTION_CHARS, MAX_MCP_TOOLS, MAX_SCHEMA_CHARS, MAX_SNAPSHOT_BYTES, TOOL_CALL_TIMEOUT_MS } from "./limits.js";
import { mcpToolName } from "./names.js";
import { toolOutput } from "./output.js";

const CLIENT_INFO = { name: "chat-lite", version: "1.0.0" };
/** A server whose cursor never ends can't keep us listing. */
const MAX_TOOL_PAGES = 10;
/** The MCP spec's rule for tool names. A name shows on approval cards, so one that breaks it is never kept. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Whether a server wants OAuth, read from how it answers a bare `initialize`. */
export async function probe(url: string, f: typeof fetch): Promise<{ auth: "none" } | { auth: "oauth"; resourceMetadataUrl?: URL; scope?: string }> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    }),
  });
  await res.body?.cancel();
  if (res.status === 401) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
    return { auth: "oauth", resourceMetadataUrl, scope };
  }
  if (!res.ok) throw new UserError(`${new URL(url).hostname} answered with status ${res.status}.`);
  return { auth: "none" };
}

/** A fresh client for one piece of work; servers are reached statelessly, so nothing is kept between calls. */
async function withClient<T>(url: string, bearer: string | undefined, f: typeof fetch, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(CLIENT_INFO);
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : undefined;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: f, requestInit: { headers } }));
    return await use(client);
  } catch (e) {
    // Without an auth provider the transport reports a 401 as a plain HTTP error; callers refresh on Unauthorized.
    if (e instanceof StreamableHTTPError && e.code === 401) throw new UnauthorizedError();
    throw e;
  } finally {
    await client.close();
  }
}

function toolInfo(t: Tool): McpToolInfo {
  return {
    name: t.name,
    description: cut(t.description ?? "", MAX_DESCRIPTION_CHARS),
    inputSchema: t.inputSchema,
    readOnly: t.annotations?.readOnlyHint === true,
  };
}

/**
 * The snapshot an admin approves: the first tools in listed order, each small enough to send to a model, and all of
 * them small enough to store. Two tools the model would see under one name (`get.user` and `get_user`, or a page
 * listed twice) would make every model call in the room fail, so only the first is kept.
 */
export function listRemoteTools(
  server: string, url: string, bearer: string | undefined, f: typeof fetch,
): Promise<{ tools: McpToolInfo[]; toolCount: number }> {
  return withClient(url, bearer, f, async (client) => {
    const listed: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const answer = await client.listTools(cursor ? { cursor } : undefined);
      listed.push(...answer.tools);
      cursor = answer.nextCursor;
      if (!cursor) break;
    }
    const tools: McpToolInfo[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const t of listed) {
      const shown = mcpToolName(server, t.name);
      if (!TOOL_NAME.test(t.name) || seen.has(shown) || JSON.stringify(t.inputSchema).length > MAX_SCHEMA_CHARS) continue;
      const info = toolInfo(t);
      bytes += Buffer.byteLength(JSON.stringify(info));
      if (tools.length === MAX_MCP_TOOLS || bytes > MAX_SNAPSHOT_BYTES) break;
      seen.add(shown);
      tools.push(info);
    }
    return { tools, toolCount: listed.length };
  });
}

export function callRemoteTool(url: string, bearer: string | undefined, tool: string, input: Record<string, unknown>, f: typeof fetch): Promise<ToolResult> {
  return withClient(url, bearer, f, async (client) => {
    const result = await client.callTool({ name: tool, arguments: input }, undefined, { timeout: TOOL_CALL_TIMEOUT_MS });
    // The default result schema parses every answer into this shape (content defaults to []); the declared return
    // type also covers the old protocol's compatibility shape, which only that other schema produces.
    return toolOutput(result as CallToolResult);
  });
}
