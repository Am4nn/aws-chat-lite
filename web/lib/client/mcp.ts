import type { McpConnection, McpToolInfo } from "../types";

export const toolLabel = (t: McpToolInfo) => (t.readOnly ? "read-only" : "asks first");

/** Shown when the server listed more tools than a connection keeps. */
export const keptLine = (c: McpConnection) => (c.tools.length < c.toolCount ? `${c.tools.length} of ${c.toolCount} tools kept` : null);

/**
 * Where the OAuth return route sends the browser once the API has finished (or refused) the flow: back to the room
 * with the server's name or the error for its toast, or home when the API couldn't tell which room the flow was for.
 */
export function callbackTarget({ status, body }: {
  status: number; body: { roomId?: string; connection?: McpConnection; error?: string };
}): string {
  const room = body.roomId ? `/r/${body.roomId}` : "/";
  const query = new URLSearchParams(status < 300 && body.connection
    ? [["mcp", body.connection.name]]
    : [["mcpError", body.error ?? "Something went wrong."]]);
  return `${room}?${query}`;
}

const FLOW_STARTED = "mcp-flow-started";

/** Set just before this tab leaves for a server's sign-in. Storage can be blocked, and then no result shows. */
export function markFlowStarted() {
  try {
    sessionStorage.setItem(FLOW_STARTED, "1");
  } catch {}
}

/**
 * The toast for a return from a server's sign-in, or null. Any link can carry `?mcp=` or `?mcpError=`, so only a return
 * this tab started a flow for shows one, and only once.
 */
export function returnToast(mcp: string | null, mcpError: string | null): { text: string; kind: "done" | "error" } | null {
  const text = mcpError ?? (mcp && `Connected ${mcp}`);
  if (!text) return null;
  try {
    if (sessionStorage.getItem(FLOW_STARTED) === null) return null;
    sessionStorage.removeItem(FLOW_STARTED);
  } catch {
    return null;
  }
  return { text, kind: mcpError ? "error" : "done" };
}
