import { mcpTool } from "../mcp/client/tools.js";
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

/** The room's remote MCP servers, with the room they belong to, since a call goes out on that room's sign-in. */
export type RoomMcp = { roomId: string; mcp: McpConnection[] };

const mcpTools = ({ roomId, mcp }: RoomMcp) => mcp.flatMap((conn) => conn.tools.map((info) => mcpTool(roomId, conn, info)));

/** Any of the room's tools, a server that needs reconnecting included, so its own check can say so. */
export const findTool = (name: string, room: RoomMcp): Tool | undefined =>
  [...ALL_TOOLS, ...mcpTools(room)].find((t) => t.spec.name === name);

/**
 * GitHub's tools need the room's connection, and a server's MCP tools a signed-in connection. Both need a model that
 * may see private content, since what they return taints the thread.
 */
export function roomTools({ github, roomId, mcp, privateOk }: RoomMcp & { github: boolean; privateOk: boolean }): Tool[] {
  if (!privateOk) return WEB_TOOLS;
  return [...(github ? ALL_TOOLS : WEB_TOOLS), ...mcpTools({ roomId, mcp: mcp.filter((c) => c.status === "connected") })];
}

const fakeFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  return url.startsWith("https://api.github.com/") ? fakeGitHubFetch(input, init) : fakeWebFetch(input, init);
};

const mcpCall: ToolEnv["mcpCall"] = () => Promise.reject(new Error("MCP calls aren't wired."));

/** Fake mode answers as GitHub and Tavily and serves canned pages, so every real code path runs without the network. */
export async function toolEnv(mode = process.env.TOOL_MODE, github?: GitHubConnection): Promise<ToolEnv> {
  if (mode === "live") return { fetch, fetchPage, keys: await toolKeys(), github, mcpCall };
  return { fetch: fakeFetch, fetchPage: fakePage, keys: fakeKeys(), github, mcpCall };
}
