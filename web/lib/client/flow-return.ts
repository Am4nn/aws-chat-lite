const FLOW_STARTED = "sign-in-started";

/** Set just before this tab leaves for a sign-in (a remote MCP server's or GitHub's). Storage can be blocked, and then no result shows. */
export function markFlowStarted() {
  try {
    sessionStorage.setItem(FLOW_STARTED, "1");
  } catch {}
}

/**
 * Whether this tab started the sign-in it is back from, true only once. Any link can carry `?mcp=`, `?mcpError=`,
 * `?github=pick` or `?githubError=`, so only a return this tab started may show its result.
 */
export function takeFlowMark(): boolean {
  try {
    if (sessionStorage.getItem(FLOW_STARTED) === null) return false;
    sessionStorage.removeItem(FLOW_STARTED);
    return true;
  } catch {
    return false;
  }
}
