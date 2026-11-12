import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { UserError } from "../../lib/errors.js";

export const needsReconnecting = (name: string) => `${name} needs reconnecting. An admin can reconnect it in the room panel.`;
export const noSuchServer = (name: string) => `This room has no MCP server called ${name}.`;

/**
 * A remote server's failure as one short line of our own, for the admin or the run. An error's own words are the
 * server's or the network's, so only codes pass: the OAuth code is one of the SDK's own classes, the others are
 * numbers. The SDK's OAuth and HTTP errors quote the server's answer body, which could echo a refresh token we sent,
 * so those stay out of the log too.
 */
export function remoteFailure(who: string, e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof OAuthError) return `${who} refused chat-lite's sign-in (${e.errorCode}).`;
  if (e instanceof StreamableHTTPError) return `${who} answered with status ${e.code}.`;
  console.error("MCP server failed", who, e);
  if (e instanceof McpError) return `${who} refused the call (error ${e.code}).`;
  if (e instanceof Error && e.name === "ZodError") return `${who} sent an answer chat-lite can't read.`;
  return `${who} didn't answer.`;
}
