import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { requiredEnv } from "../lib/env.js";
import type { Scope } from "../threads/types.js";

const SCOPES: Scope[] = ["rooms:read", "rooms:write"];

/** An OAuth error as RFC 6749 names it: `code` goes out as `error`, the message as `error_description`. */
export class OAuthError extends Error {
  constructor(readonly code: string, description: string, readonly status = 400) {
    super(description);
  }
}

/** The issuer, and the base every OAuth and MCP URL is built on. */
export const issuer = () => requiredEnv("MCP_BASE_URL");
export const siteUrl = () => requiredEnv("SITE_URL");

/** None requested means both; the result is in a fixed order, so equal grants compare equal. */
export function parseScope(raw?: string): Scope[] {
  const asked = raw?.trim() ? raw.trim().split(/\s+/) : SCOPES;
  if (!asked.every((s) => (SCOPES as string[]).includes(s))) throw new OAuthError("invalid_scope", "Ask for rooms:read, rooms:write or both.");
  return SCOPES.filter((s) => asked.includes(s));
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * https, or http on a loopback host for native apps (RFC 8252). Custom schemes are refused because any app on the
 * device can claim one, and RFC 6749 forbids a fragment.
 */
export function validRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
}

/**
 * Exact string match, except that a loopback http URI matches on any port: native apps listen on whatever port is
 * free when they start (RFC 8252 §7.3).
 */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  if (!validRedirectUri(given) || !given.startsWith("http:")) return false;
  const withoutPort = (uri: string) => {
    const url = new URL(uri);
    url.port = "";
    return url.href;
  };
  return registered.some((r) => r.startsWith("http:") && withoutPort(r) === withoutPort(given));
}

/** PKCE S256 (RFC 7636). Compared in constant time, so the response time says nothing about the challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

/**
 * A random secret and the hash we keep in its place. Tokens carry their grant id, so checking one is a single read by
 * key, while the 256 random bits keep it unguessable.
 */
export function newSecret(kind: "at" | "rt" | "code", grantId?: string) {
  const token = `cl_${kind}_${grantId ? `${grantId}_` : ""}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashOf(token) };
}

export function grantIdOf(token: string): string | null {
  return /^cl_(?:at|rt)_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/.exec(token)?.[1] ?? null;
}

/** RFC 8414. */
export function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728: where an MCP client that got a 401 from /mcp learns which server issues its tokens. */
export function resourceMetadata(base: string) {
  return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: SCOPES, bearer_methods_supported: ["header"], resource_name: "chat-lite" };
}
