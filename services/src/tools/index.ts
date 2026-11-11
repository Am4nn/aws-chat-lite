import { mcpRepo } from "../mcp/client/repo.js";
import { mcpCaller, mcpTool } from "../mcp/client/tools.js";
import { memoryTools } from "../memory/tools.js";
import type { GitHubConnection, McpConnection } from "../threads/types.js";
import { fakeGitHubFetch, fakeKeys } from "./fake-github.js";
import { fakePage, fakeWebFetch } from "./fake-web.js";
import { GITHUB_TOOLS } from "./github/tools.js";
import { toolKeys } from "./keys.js";
import type { Tool, ToolEnv } from "./types.js";
import { fetchPage, webFetch } from "./web/fetch.js";
import { webSearch } from "./web/search.js";

const WEB_TOOLS = [webSearch, webFetch];
const ALL_TOOLS = [...WEB_TOOLS, ...GITHUB_TOOLS];
const MEMORY_TOOLS = memoryTools();

/** The room's remote MCP servers, with the room they belong to, since a call goes out on that room's sign-in. */
export type RoomMcp = { roomId: string; mcp: McpConnection[] };

const mcpTools = ({ roomId, mcp }: RoomMcp) => mcp.flatMap((conn) => conn.tools.map((info) => mcpTool(roomId, conn, info)));

/** Any of the room's tools, a server that needs reconnecting included, so its own check can say so. */
export const findTool = (name: string, room: RoomMcp): Tool | undefined =>
  [...ALL_TOOLS, ...MEMORY_TOOLS, ...mcpTools(room)].find((t) => t.spec.name === name);

/**
 * GitHub's tools need the room's connection, and a server's MCP tools a signed-in connection. Both need a model that
 * may see private content, since what they return taints the thread. The memory tools go to every model: what a
 * private thread saves is kept from the models that may not see it.
 */
export function roomTools({ github, roomId, mcp, privateOk }: RoomMcp & { github: boolean; privateOk: boolean }): Tool[] {
  if (!privateOk) return [...WEB_TOOLS, ...MEMORY_TOOLS];
  return [
    ...(github ? ALL_TOOLS : WEB_TOOLS), ...mcpTools({ roomId, mcp: mcp.filter((c) => c.status === "connected") }), ...MEMORY_TOOLS,
  ];
}

const fakeFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  return url.startsWith("https://api.github.com/") ? fakeGitHubFetch(input, init) : fakeWebFetch(input, init);
};

// Both modes call MCP servers for real: locally that is the test server on this machine.
const mcpCall = mcpCaller(mcpRepo);

/**
 * Fake mode answers as GitHub and Tavily and serves canned pages, so every real code path runs without the network.
 * The run adds the thread the call is made for.
 */
export async function toolEnv(mode = process.env.TOOL_MODE, github?: GitHubConnection): Promise<Omit<ToolEnv, "room">> {
  if (mode === "live") return { fetch, fetchPage, keys: await toolKeys(), github, mcpCall };
  return { fetch: fakeFetch, fetchPage: fakePage, keys: fakeKeys(), github, mcpCall };
}
