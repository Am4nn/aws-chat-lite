/** Discovery, registration, token and revoke requests; a remote server that hangs can't hold a Lambda for long. */
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_ANSWER_BYTES = 2_000_000;
export const MAX_URL_CHARS = 500;
/** A tool call may run long on the remote side; the deadline covers the whole exchange, answer included. */
export const TOOL_CALL_TIMEOUT_MS = 60_000;
export const MAX_MCP_SERVERS = 5;
/** Every tool's schema goes into each model call, so a server's snapshot is capped. */
export const MAX_MCP_TOOLS = 40;
export const MAX_DESCRIPTION_CHARS = 1_000;
export const MAX_SCHEMA_CHARS = 10_000;
