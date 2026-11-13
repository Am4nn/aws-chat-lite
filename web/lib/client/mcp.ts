import type { McpConnection, McpToolInfo } from "../types";

/**
 * A destructive tool asks in every approval mode, and a tool from an older snapshot counts as destructive; any other
 * write asks as the room's mode decides.
 */
export const toolLabel = (t: McpToolInfo) => (t.readOnly ? "read-only" : t.destructive === false ? "may ask first" : "asks first");

/** Shown when the server listed more tools than a connection keeps. */
export const keptLine = (c: McpConnection) => (c.tools.length < c.toolCount ? `${c.tools.length} of ${c.toolCount} tools kept` : null);

/** Servers an admin can connect in one click. */
export const MCP_CATALOG = [
  { name: "linear", label: "Linear", url: "https://mcp.linear.app/mcp" },
  { name: "notion", label: "Notion", url: "https://mcp.notion.com/mcp" },
];
