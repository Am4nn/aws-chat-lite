import type { GitHubConnection } from "../../threads/types.js";

/**
 * The repo a GitHub tool call acts on, which must be one the room connected: the model's input can name any repo the
 * App can reach, and this is what keeps it inside the room's choice.
 */
export function repoOf(input: Record<string, unknown>, conn?: GitHubConnection): string | { error: string } {
  if (!conn) return { error: "GitHub isn't connected to this room. An admin can connect it in the room panel." };
  const connected = conn.repos.join(", ");
  if (input.repo === undefined) return conn.repos.length === 1 ? conn.repos[0] : { error: `Say which repo: ${connected}.` };
  const repo = String(input.repo);
  // GitHub treats owner and repo names case-insensitively.
  return conn.repos.find((r) => r.toLowerCase() === repo.toLowerCase()) ?? { error: `${repo} isn't connected to this room. Connected: ${connected}.` };
}
