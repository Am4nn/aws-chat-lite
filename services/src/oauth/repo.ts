import { randomBytes, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { User } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { conditionFailed, docClient, queryAll, tableName, transactionConflict } from "../lib/db.js";
import { Conflict, NotFound, ValidationError } from "../lib/errors.js";
import { countTowardsRate } from "../lib/rate.js";
import { userActive } from "../lib/users.js";
import type { McpApp, Scope } from "../threads/types.js";
import {
  OAuthError, grantIdOf, hashOf, issuer, newSecret, parseScope, redirectMatches, siteUrl, validRedirectUri, verifyPkce,
} from "./model.js";

const REQUEST_TTL_SEC = 600;
const CODE_TTL_SEC = 60;
const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 30 * 86400;
const CLIENT_TTL_SEC = 30 * 86400;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;
const PER_HOUR = { register: 20, authorize: 60 };
const LAST_USED_EVERY_MS = 60_000;
/** How long the refresh token a rotation just replaced reads as a race rather than a leak. */
const REUSE_GRACE_SEC = 30;
/** Used, expired or never issued all read the same, as a 404, so the consent page can say so without telling them apart. */
const REQUEST_EXPIRED = "This sign-in request expired. Start again from your app.";

type Item = Record<string, unknown>;

const nowSec = () => Math.floor(Date.now() / 1000);
const clientKey = (clientId: string) => ({ pk: `OAUTHCLIENT#${clientId}`, sk: "META" });
const requestKey = (requestId: string) => ({ pk: `OAUTHREQ#${requestId}`, sk: "META" });
const codeKey = (hash: string) => ({ pk: `OAUTHCODE#${hash}`, sk: "META" });
const grantKey = (grantId: string) => ({ pk: `OAUTHGRANT#${grantId}`, sk: "META" });
const TTL_NAME = { "#ttl": "ttl" };

/** The TTL sweep can lag by days, so every read checks expiry itself. */
const live = (item: Item | undefined) => (item && Number(item.ttl) > nowSec() ? item : undefined);

const invalidGrant = () => new OAuthError("invalid_grant", "The code or refresh token is invalid, expired or already used.");
const invalidClient = () => new OAuthError("invalid_client", "This app isn't registered with chat-lite, or its registration expired.", 401);

function newTokens(grantId: string) {
  const access = newSecret("at", grantId);
  const refresh = newSecret("rt", grantId);
  const hashes = { accessHash: access.hash, accessExp: nowSec() + ACCESS_TTL_SEC, refreshHash: refresh.hash, ttl: nowSec() + REFRESH_TTL_SEC };
  return { access, refresh, hashes };
}

const tokenResponse = ({ access, refresh }: ReturnType<typeof newTokens>, scopes: unknown) => ({
  access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: refresh.token, scope: (scopes as Scope[]).join(" "),
});

/** RFC 8707: chat-lite's tokens are good for one resource only, its /mcp endpoint. */
function checkResource(resource: string | null | undefined) {
  const ours = `${issuer()}/mcp`;
  if (resource && resource !== ours) throw new OAuthError("invalid_target", `This server issues tokens for ${ours} only.`);
}

/** Back to the client's redirect URI, with `iss` so a client of several servers knows whose answer it is (RFC 9207). */
function backToClient(redirectUri: string, params: Record<string, unknown>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...params, iss: issuer() })) if (typeof value === "string") url.searchParams.set(key, value);
  return url.href;
}

/**
 * An OAuth 2.1 authorization server for MCP clients. Sign-in and consent happen on the web app's consent page, so this
 * never sees a password. Every client is public (PKCE instead of a secret), and every token is opaque: only its
 * SHA-256 hash is stored, all on one grant item per app, so revoking an app is deleting that item. `accountActive`
 * says whether the user's account still exists.
 */
export function oauthRepo(accountActive: (username: string) => Promise<boolean> = userActive) {
  const db = docClient();
  const TableName = tableName();

  const read = async (Key: Item) => (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
  const deleteGrant = (grantId: string) => db.send(new DeleteCommand({ TableName, Key: grantKey(grantId) }));
  const getClient = async (clientId: unknown) =>
    typeof clientId === "string" && clientId ? live(await read(clientKey(clientId))) : undefined;

  /** Registration and authorize are open to anyone, so each source address gets a fixed hourly allowance. */
  async function hit(kind: keyof typeof PER_HOUR, ip: string) {
    try {
      await countTowardsRate(`RATE#oauth#${kind}#${ip}`, { windowSec: 3600, max: PER_HOUR[kind], message: "slow_down" });
    } catch (e) {
      if (e instanceof Conflict) throw new OAuthError("slow_down", "Too many requests from this address. Try again later.", 429);
      throw e;
    }
  }

  /** Every issue extends the client's life, so only registrations nobody uses expire. */
  const touchClient = (clientId: unknown) => ({
    Update: {
      TableName, Key: clientKey(String(clientId)), UpdateExpression: "SET #ttl = :ttl",
      ExpressionAttributeNames: TTL_NAME, ExpressionAttributeValues: { ":ttl": nowSec() + CLIENT_TTL_SEC },
    },
  });

  /**
   * A code presented after it was exchanged means someone else holds it too, and we can't tell which presenter is
   * genuine, so the grant it made is revoked (RFC 6749 §4.1.2).
   */
  async function codeReused(code: Item | undefined) {
    if (code?.grantId) await deleteGrant(String(code.grantId));
    return invalidGrant();
  }

  async function exchangeCode(form: URLSearchParams) {
    const hash = hashOf(form.get("code") ?? "");
    const stored = await read(codeKey(hash));
    if (stored?.grantId) throw await codeReused(stored);
    const code = live(stored);
    if (!code) throw invalidGrant();
    const client = await getClient(form.get("client_id"));
    if (!client) throw invalidClient();
    if (code.clientId !== client.clientId || code.redirectUri !== form.get("redirect_uri")
      || !verifyPkce(form.get("code_verifier") ?? "", String(code.codeChallenge))) throw invalidGrant();
    checkResource(form.get("resource"));

    const grantId = randomUUID();
    const tokens = newTokens(grantId);
    const at = new Date().toISOString();
    const grant = {
      ...grantKey(grantId), grantId, clientId: client.clientId, clientName: client.clientName, userId: code.userId, username: code.username,
      scopes: code.scopes, createdAt: at, lastUsedAt: at, ...tokens.hashes, gsi1pk: `MCPAPPS#${code.userId}`, gsi1sk: at,
    };
    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName, Key: codeKey(hash), UpdateExpression: "SET grantId = :g",
              ConditionExpression: "attribute_not_exists(grantId)", ExpressionAttributeValues: { ":g": grantId },
            },
          },
          { Put: { TableName, Item: grant } },
          touchClient(client.clientId),
        ],
      }));
    } catch (e) {
      if (conditionFailed(e)) throw await codeReused(await read(codeKey(hash)));
      throw e;
    }
    return tokenResponse(tokens, code.scopes);
  }

  /**
   * Refresh tokens rotate, and the old one stops working. One presented again means it leaked (RFC 9700 §4.14), so the
   * whole grant goes, unless the rotation that replaced it happened moments ago: then it is one client refreshing
   * twice at once, and only the loser is refused. A refresh also ends the grant of an account deleted or disabled
   * since, so an app can keep a user's access an hour at most after that. The scope never changes on refresh.
   */
  async function refresh(form: URLSearchParams) {
    const token = form.get("refresh_token") ?? "";
    const grantId = grantIdOf(token);
    if (!grantId || !token.startsWith("cl_rt_")) throw invalidGrant();
    const grant = live(await read(grantKey(grantId)));
    if (!grant) throw invalidGrant();
    const revoked = async () => {
      await deleteGrant(grantId);
      return invalidGrant();
    };
    const presented = hashOf(token);
    if (presented !== grant.refreshHash) {
      if (presented === grant.prevRefreshHash && nowSec() - Number(grant.rotatedAt) <= REUSE_GRACE_SEC) throw invalidGrant();
      throw await revoked();
    }
    const client = await getClient(form.get("client_id"));
    if (!client) throw invalidClient();
    if (client.clientId !== grant.clientId) throw invalidGrant();
    checkResource(form.get("resource"));
    if (!(await accountActive(String(grant.username)))) throw await revoked();

    const tokens = newTokens(grantId);
    const { accessHash, accessExp, refreshHash, ttl } = tokens.hashes;
    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName, Key: grantKey(grantId),
              UpdateExpression: "SET accessHash = :ah, accessExp = :ae, refreshHash = :rh, prevRefreshHash = :old, rotatedAt = :now, #ttl = :ttl",
              ConditionExpression: "refreshHash = :old", ExpressionAttributeNames: TTL_NAME,
              ExpressionAttributeValues: {
                ":ah": accessHash, ":ae": accessExp, ":rh": refreshHash, ":ttl": ttl, ":old": presented, ":now": nowSec(),
              },
            },
          },
          touchClient(client.clientId),
        ],
      }));
    } catch (e) {
      // The token matched when read, so another refresh with it got there first.
      if (conditionFailed(e) || transactionConflict(e)) throw invalidGrant();
      throw e;
    }
    return tokenResponse(tokens, grant.scopes);
  }

  return {
    /** RFC 7591. Whatever auth method is asked for, the client is registered as public, as the RFC allows. */
    async registerClient(body: unknown, ip: string) {
      await hit("register", ip);
      const meta = (body && typeof body === "object" ? body : {}) as Item;
      const uris = meta.redirect_uris;
      if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri)) {
        throw new OAuthError("invalid_redirect_uri", "Give 1 to 10 redirect URIs, each https or http on localhost.");
      }
      const name = typeof meta.client_name === "string" ? meta.client_name.trim().slice(0, MAX_CLIENT_NAME) : "";
      const clientName = name || "MCP client";
      const clientId = randomUUID();
      const issuedAt = nowSec();
      await db.send(new PutCommand({
        TableName, Item: { ...clientKey(clientId), clientId, clientName, redirectUris: uris, ttl: issuedAt + CLIENT_TTL_SEC },
      }));
      return {
        client_id: clientId, client_id_issued_at: issuedAt, client_name: clientName, redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      };
    },

    /**
     * Every fault is answered here as an error page, never redirected: anyone can register any https address, so a
     * registered redirect URI is still untrusted, and an instant redirect to it would make this an open redirector
     * (RFC 9700 §4.11.2). The user only goes back to the client after choosing on the consent page, which names it.
     */
    async startRequest(q: Record<string, string | undefined>, ip: string): Promise<{ consent: string } | { error: string; status: number }> {
      await hit("authorize", ip);
      const refuse = (error: string) => ({ error, status: 400 });
      const client = await getClient(q.client_id);
      if (!client) return refuse("This app isn't registered with chat-lite, or its registration expired.");
      const redirectUri = q.redirect_uri;
      if (!redirectUri || !redirectMatches(client.redirectUris as string[], redirectUri)) {
        return refuse("This redirect URI isn't registered for the app.");
      }
      if (q.response_type !== "code") return refuse("Only response_type=code is supported.");
      if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "")) {
        return refuse("A PKCE code_challenge with method S256 is required.");
      }
      let scopes: Scope[];
      try {
        scopes = parseScope(q.scope);
        checkResource(q.resource);
      } catch (e) {
        if (e instanceof OAuthError) return refuse(e.message);
        throw e;
      }
      const requestId = randomBytes(16).toString("base64url");
      await db.send(new PutCommand({
        TableName,
        Item: {
          ...requestKey(requestId), clientId: client.clientId, clientName: client.clientName, redirectUri, state: q.state,
          codeChallenge: q.code_challenge, scopes, ttl: nowSec() + REQUEST_TTL_SEC,
        },
      }));
      return { consent: `${siteUrl()}/consent?request=${requestId}` };
    },

    async getRequest(requestId: string) {
      const request = live(await read(requestKey(requestId)));
      if (!request) throw new NotFound(REQUEST_EXPIRED);
      return {
        clientName: String(request.clientName), redirectHost: new URL(String(request.redirectUri)).host,
        scopes: request.scopes as Scope[], expiresAt: new Date(Number(request.ttl) * 1000).toISOString(),
      };
    },

    /** The conditional delete makes a request usable once, even when the consent page is submitted twice. */
    async decide(user: User, requestId: string, decision: unknown): Promise<{ redirectTo: string }> {
      if (decision !== "allow" && decision !== "deny") throw new ValidationError("Choose allow or deny.");
      let request: Item;
      try {
        request = (await db.send(new DeleteCommand({
          TableName, Key: requestKey(requestId), ReturnValues: "ALL_OLD", ConditionExpression: "#ttl > :now",
          ExpressionAttributeNames: TTL_NAME, ExpressionAttributeValues: { ":now": nowSec() },
        }))).Attributes!;
      } catch (e) {
        if (conditionFailed(e)) throw new NotFound(REQUEST_EXPIRED);
        throw e;
      }
      const redirectUri = String(request.redirectUri);
      if (decision === "deny") return { redirectTo: backToClient(redirectUri, { error: "access_denied", state: request.state }) };
      const code = newSecret("code");
      await db.send(new PutCommand({
        TableName,
        Item: {
          ...codeKey(code.hash), clientId: request.clientId, redirectUri, codeChallenge: request.codeChallenge, scopes: request.scopes,
          userId: user.userId, username: user.username, ttl: nowSec() + CODE_TTL_SEC,
        },
      }));
      return { redirectTo: backToClient(redirectUri, { code: code.token, state: request.state }) };
    },

    async token(form: URLSearchParams) {
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") return exchangeCode(form);
      if (grantType === "refresh_token") return refresh(form);
      throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    },

    /**
     * RFC 7009: either token of a grant revokes the whole grant. An unknown token is not an error, so revocation
     * can't be used to probe which tokens exist.
     */
    async revoke(form: URLSearchParams) {
      const token = form.get("token") ?? "";
      const grantId = grantIdOf(token);
      if (!grantId) return;
      try {
        await db.send(new DeleteCommand({
          TableName, Key: grantKey(grantId), ConditionExpression: "accessHash = :h OR refreshHash = :h", ExpressionAttributeValues: { ":h": hashOf(token) },
        }));
      } catch (e) {
        if (!conditionFailed(e)) throw e;
      }
    },

    /** Read on every MCP request; the read is consistent, so a revoked app is locked out at once. */
    async verifyAccess(token: string): Promise<{ user: User; scopes: Scope[]; grantId: string } | null> {
      const grantId = grantIdOf(token);
      if (!grantId) return null;
      const grant = await read(grantKey(grantId));
      if (!grant || hashOf(token) !== grant.accessHash || Number(grant.accessExp) <= nowSec()) return null;
      if (Date.parse(String(grant.lastUsedAt)) < Date.now() - LAST_USED_EVERY_MS) {
        await bestEffort("lastUsedAt update", () => db.send(new UpdateCommand({
          TableName, Key: grantKey(grantId), UpdateExpression: "SET lastUsedAt = :at",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":at": new Date().toISOString() },
        })));
      }
      return { user: { userId: String(grant.userId), username: String(grant.username) }, scopes: grant.scopes as Scope[], grantId };
    },

    async listApps(userId: string): Promise<McpApp[]> {
      const grants = await queryAll({
        IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :u", ExpressionAttributeValues: { ":u": `MCPAPPS#${userId}` },
      });
      return grants.filter((g) => live(g)).map((g) => ({
        grantId: String(g.grantId), clientName: String(g.clientName), scopes: g.scopes as Scope[],
        createdAt: String(g.createdAt), lastUsedAt: String(g.lastUsedAt),
      }));
    },

    async revokeApp(userId: string, grantId: string) {
      try {
        await db.send(new DeleteCommand({
          TableName, Key: grantKey(grantId), ConditionExpression: "userId = :u", ExpressionAttributeValues: { ":u": userId },
        }));
      } catch (e) {
        if (conditionFailed(e)) throw new NotFound("No such app.");
        throw e;
      }
    },
  };
}

export type OAuthRepo = ReturnType<typeof oauthRepo>;
