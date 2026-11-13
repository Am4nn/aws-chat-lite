import type { McpConnection, McpToolInfo } from "../types";

export const toolLabel = (t: McpToolInfo) => (t.readOnly ? "read-only" : "asks first");

/** Shown when the server listed more tools than a connection keeps. */
export const keptLine = (c: McpConnection) => (c.tools.length < c.toolCount ? `${c.tools.length} of ${c.toolCount} tools kept` : null);

/** Servers an admin can connect in one click. */
export const MCP_CATALOG = [
  { name: "linear", label: "Linear", url: "https://mcp.linear.app/mcp" },
  { name: "notion", label: "Notion", url: "https://mcp.notion.com/mcp" },
];
