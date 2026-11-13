import net from "node:net";
import { ValidationError } from "../../lib/errors.js";
import { isPublicAddress } from "../../tools/web/guard.js";
import { MAX_URL_CHARS } from "./limits.js";

const KEY_PARAM = /key|token|secret|password|auth|sig/i;

/** Hosts that may use http and private addresses. Only the local stage sets them, so Floci's Lambdas can reach this machine. */
export function localHosts(env: Record<string, string | undefined> = process.env): string[] {
  return (env.MCP_LOCAL_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

/**
 * A URL chat-lite may send a request or a browser to: https, or http on a local host; no userinfo, which can disguise
 * the real host; and no private IP literal, since a socket lookup never runs for one.
 */
export function browserUrl(raw: string, localHosts: string[]): URL {
  if (raw.length > MAX_URL_CHARS) throw new ValidationError(`That URL is over ${MAX_URL_CHARS} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("That isn't a valid URL.");
  }
  const local = localHosts.includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new ValidationError("Use an https URL.");
  if (url.username || url.password) throw new ValidationError("Links with a username or password aren't allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!local && net.isIP(host) && !isPublicAddress(host)) throw new ValidationError("That address is private.");
  return url;
}

/** chat-lite's own MCP endpoint on every origin it is served from. */
export function ownMcpUrls(env: Record<string, string | undefined> = process.env): string[] {
  return [...(env.SITE_ORIGINS ?? "").split(","), env.MCP_BASE_URL ?? ""]
    .map((base) => base.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .map((base) => `${base}/mcp`)
    .filter((url) => URL.canParse(url));
}

/** Where a request for this URL lands: case, repeated slashes, percent-escapes and a trailing slash don't change the endpoint. */
function endpoint(url: URL): string {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape can't name our endpoint, so the raw path is compared.
  }
  return url.origin + path.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** A remote MCP server's URL as an admin typed it. */
export function mcpServerUrl(raw: unknown, localHosts: string[], own: string[] = ownMcpUrls()): URL {
  if (typeof raw !== "string") throw new ValidationError("That isn't a valid URL.");
  const url = browserUrl(raw.trim(), localHosts);
  // The URL is shown to every member and stored in plain text, unlike the sealed OAuth tokens.
  if ([...url.searchParams.keys()].some((name) => KEY_PARAM.test(name))) {
    throw new ValidationError("Don't put keys in the URL: chat-lite signs in with OAuth.");
  }
  // Connecting a room to its own server would loop its agents' calls back through chat-lite.
  if (own.some((candidate) => endpoint(new URL(candidate)) === endpoint(url))) throw new ValidationError("That's chat-lite's own MCP server.");
  return url;
}
