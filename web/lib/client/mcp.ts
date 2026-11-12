import type { McpConnection, McpToolInfo } from "../types";

export const toolLabel = (t: McpToolInfo) => (t.readOnly ? "read-only" : "asks first");

/** Shown when the server listed more tools than a connection keeps. */
export const keptLine = (c: McpConnection) => (c.tools.length < c.toolCount ? `${c.tools.length} of ${c.toolCount} tools kept` : null);
