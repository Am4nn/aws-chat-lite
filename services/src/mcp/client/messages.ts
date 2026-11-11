import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const MAX_LINE = 200;

export const needsReconnecting = (name: string) => `${name} needs reconnecting. An admin can reconnect it in the room panel.`;
export const noSuchServer = (name: string) => `This room has no MCP server called ${name}.`;

/**
 * A remote server's failure as one short line, for the admin or the run. The SDK's OAuth and HTTP errors quote the
 * server's answer body, which could echo what we sent it (a refresh token, say), so those keep only their code.
 */
export function remoteFailure(who: string, e: unknown): string {
  if (e instanceof OAuthError) return `${who} refused chat-lite's sign-in (${e.errorCode}).`;
  if (e instanceof StreamableHTTPError) return `${who} answered with status ${e.code}.`;
  if (e instanceof Error && e.name === "ZodError") return `${who} sent an answer chat-lite can't read.`;
  const message = e instanceof Error ? e.message.replace(/\s+/g, " ").trim() : "";
  if (!message) return `${who} didn't answer.`;
  return `${who} didn't answer: ${message.length > MAX_LINE ? `${message.slice(0, MAX_LINE)}…` : message}`;
}
