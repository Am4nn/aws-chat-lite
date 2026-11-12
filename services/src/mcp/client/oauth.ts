import { randomBytes } from "node:crypto";
import {
  UnauthorizedError,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { UserError } from "../../lib/errors.js";
import type { probe } from "./remote.js";
import { NeedsAuth, type PendingAuth, type StoredAuth, type TokenStore } from "./types.js";
import { browserUrl } from "./url.js";

/** Refresh a little early, so a token doesn't expire between the check and the server reading it. */
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_SEC = 3_600;
/**
 * How long a run that lost a refresh race waits for the winner to save. The winner's refresh answer comes back
 * just before the loser's `invalid_grant`, but its save to the table may still be in flight.
 */
const RACE_GRACE_MS = 500;

type Probed = Extract<Awaited<ReturnType<typeof probe>>, { auth: "oauth" }>;
type Base = Omit<StoredAuth, "tokens" | "expiresAt">;
type Loaded = { auth: StoredAuth; version: number };

const signedIn = (base: Base, tokens: OAuthTokens): StoredAuth => ({
  issuer: base.issuer,
  metadata: base.metadata,
  client: base.client,
  tokens,
  expiresAt: Date.now() + (tokens.expires_in ?? DEFAULT_TOKEN_TTL_SEC) * 1000,
  ...(base.resource && { resource: base.resource }),
});

/**
 * Discovers the server's authorization server, registers chat-lite there (or reuses the client it registered
 * before) and builds the authorize URL the admin's browser goes to. PKCE's verifier stays server-side in `pending`.
 */
export async function beginAuthorization(
  { url, redirectUri, probed, known }: { url: string; redirectUri: string; probed: Probed; known?: Pick<StoredAuth, "issuer" | "client"> },
  f: typeof fetch,
  hosts: string[],
): Promise<{ authorizeUrl: string; state: string; pending: PendingAuth }> {
  const host = new URL(url).hostname;
  const info = await discoverOAuthServerInfo(url, { resourceMetadataUrl: probed.resourceMetadataUrl, fetchFn: f });
  const metadata = info.authorizationServerMetadata;
  if (!metadata) throw new UserError(`${host} doesn't say how to sign in, so chat-lite can't connect to it.`);
  const issuer = metadata.issuer;

  // A client registered for another of the site's return addresses would be refused at the authorize page.
  const reusable = known?.issuer === issuer && "redirect_uris" in known.client && known.client.redirect_uris.includes(redirectUri);
  let client = reusable ? known.client : undefined;
  if (!client) {
    if (!metadata.registration_endpoint) throw new UserError(`${host} doesn't let new apps sign up, so chat-lite can't connect to it.`);
    client = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: "chat-lite",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      fetchFn: f,
    });
  }

  // RFC 8707: tokens are bound to the resource the server names, sent as it wrote it, after checking it is this server.
  const prm = info.resourceMetadata;
  if (prm && !checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(url), configuredResource: prm.resource })) {
    throw new UserError(`${host} says its sign-in is for another server.`);
  }
  const resource = prm?.resource;
  const state = randomBytes(32).toString("base64url");
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: redirectUri,
    scope: probed.scope ?? prm?.scopes_supported?.join(" "),
    state,
    resource,
  });
  // The remote server chose this URL, and the admin's browser is about to be sent to it.
  browserUrl(authorizationUrl.href, hosts);
  return {
    authorizeUrl: authorizationUrl.href,
    state,
    pending: { issuer, metadata, client, codeVerifier, redirectUri, ...(resource && { resource }) },
  };
}

export async function completeAuthorization(pending: PendingAuth, code: string, f: typeof fetch): Promise<StoredAuth> {
  const tokens = await exchangeAuthorization(pending.issuer, {
    metadata: pending.metadata,
    clientInformation: pending.client,
    authorizationCode: code,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
    resource: pending.resource,
    fetchFn: f,
  });
  return signedIn(pending, tokens);
}

async function needsAuth(store: TokenStore): Promise<never> {
  await store.markNeedsAuth();
  throw new NeedsAuth();
}

/** Someone else refreshed when the stored version moved; otherwise the sign-in is really gone. */
async function winnersTokens(store: TokenStore, version: number, grace = 0): Promise<Loaded> {
  let latest = await store.load();
  if (grace && latest?.version === version) {
    await new Promise((r) => setTimeout(r, grace));
    latest = await store.load();
  }
  return latest && latest.version !== version ? latest : needsAuth(store);
}

/**
 * Refresh tokens rotate, so two runs refreshing the same token race: one wins, and the other's refresh is refused
 * with `invalid_grant`. The loser takes the winner's tokens from the store instead of asking for a reconnect.
 */
async function refreshed(store: TokenStore, { auth, version }: Loaded, f: typeof fetch): Promise<Loaded> {
  // Without a refresh token there was no refresh to lose, so only a reconnect can have moved the version on.
  if (!auth.tokens.refresh_token) return winnersTokens(store, version);
  let next: StoredAuth;
  try {
    const tokens = await refreshAuthorization(auth.issuer, {
      metadata: auth.metadata,
      clientInformation: auth.client,
      refreshToken: auth.tokens.refresh_token,
      resource: auth.resource,
      fetchFn: f,
    });
    next = signedIn(auth, tokens);
  } catch (e) {
    if (!(e instanceof InvalidGrantError)) throw e;
    return winnersTokens(store, version, RACE_GRACE_MS);
  }
  return (await store.save(next, version)) ? { auth: next, version: version + 1 } : winnersTokens(store, version);
}

/**
 * Runs `use` with a valid access token, refreshing first when it is about to expire and once more if the server
 * answers 401. Throws NeedsAuth, after marking the connection, when only an admin reconnecting can fix it.
 */
export async function withFreshAuth<T>(store: TokenStore, f: typeof fetch, use: (bearer?: string) => Promise<T>): Promise<T> {
  let current = (await store.load()) ?? (await needsAuth(store));
  if (current.auth.expiresAt - Date.now() < REFRESH_MARGIN_MS) current = await refreshed(store, current, f);
  try {
    return await use(current.auth.tokens.access_token);
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
  }
  current = await refreshed(store, current, f);
  return use(current.auth.tokens.access_token);
}

/** Tells the server to forget chat-lite's tokens when a room disconnects it. Best effort: removing must still work. */
export async function revokeRemote(auth: StoredAuth, f: typeof fetch): Promise<void> {
  // Only OAuth metadata (RFC 8414) names a revocation endpoint; OpenID discovery metadata has none.
  const endpoint = "revocation_endpoint" in auth.metadata ? auth.metadata.revocation_endpoint : undefined;
  const token = auth.tokens.refresh_token;
  if (!endpoint || !token) return;
  try {
    const res = await f(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: auth.client.client_id }),
    });
    await res.body?.cancel();
  } catch {
    // The server may be gone; its tokens are deleted on our side either way.
  }
}
