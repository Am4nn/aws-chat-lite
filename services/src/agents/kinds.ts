import { connectionsRepo } from "../connections/repo.js";
import { ValidationError } from "../lib/errors.js";
import type { ToolKind } from "../threads/types.js";

/** The sandbox and the web are every room's; GitHub and MCP need a connection (`mcp` stands for all its MCP servers). */
export async function availableKinds(roomId: string): Promise<ToolKind[]> {
  const { github, mcp } = await connectionsRepo().get(roomId);
  return [...(github ? ["github" as const] : []), ...(mcp.length ? ["mcp" as const] : []), "sandbox", "web"];
}

/**
 * An agent can't be given a kind the room has no connection for. A kind it already `has` may stay, so an edit still
 * works after an admin disconnects GitHub; the run offers only the tools that are there anyway.
 */
export async function requireOffered(roomId: string, tools: ToolKind[], has: ToolKind[] = []): Promise<void> {
  const available = await availableKinds(roomId);
  const missing = tools.find((k) => !available.includes(k) && !has.includes(k));
  if (missing) throw new ValidationError(`This room has no ${missing} connection.`);
}
