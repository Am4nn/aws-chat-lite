import { createHash } from "node:crypto";

/** Model providers take tool names of at most 64 characters from this set. */
const MAX_NAME = 64;
const PREFIX = "mcp__";

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
