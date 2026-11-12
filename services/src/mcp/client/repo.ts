import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { auditItem } from "../../audit/repo.js";
import { connectionsRepo, mcpConnKey, mcpConnections, withoutKeys } from "../../connections/repo.js";
import type { User } from "../../lib/auth.js";
import { conditionFailed, docClient, failedAt, tableName, takeOnce } from "../../lib/db.js";
import { Conflict, FlowFailed, Forbidden, Gone, NotFound, Upstream, UserError, ValidationError } from "../../lib/errors.js";
import { siteCallback } from "../../lib/http.js";
import { roomKey } from "../../lib/keys.js";
import { roomUpdated } from "../../live/broadcast.js";
import { cut } from "../../tools/cut.js";
import type { AuditKind, McpConnection } from "../../threads/types.js";
import { guardedFetch } from "./fetch.js";
import { MAX_MCP_SERVERS } from "./limits.js";
import { needsReconnecting, noSuchServer, remoteFailure } from "./messages.js";
import { beginAuthorization, completeAuthorization, revokeRemote, withFreshAuth } from "./oauth.js";
import { listRemoteTools, probe } from "./remote.js";
import { SealError, seal, tokenKey, unseal } from "./seal.js";
import { NeedsAuth, type PendingAuth, type StoredAuth, type TokenStore } from "./types.js";
import { localHosts, mcpServerUrl } from "./url.js";

type Deps = { fetch: typeof fetch; hosts: string[]; key: () => Promise<Buffer>; notifyRoom: (roomId: string) => Promise<unknown> };
/** An OAuth flow between the admin leaving for the server's authorize page and coming back. */
type Flow = { roomId: string; userId: string; name: string; url: string; reconnect: boolean; pending: string };
/** A server as connected: what the admin gave, plus the tools it listed. */
type Server = Pick<McpConnection, "name" | "url" | "auth"> & Awaited<ReturnType<typeof listRemoteTools>>;
type Started = { authorizeUrl: string } | { connection: McpConnection };

const NAME = /^[a-z0-9][a-z0-9-]{0,19}$/;
const STATE = /^[A-Za-z0-9_-]{1,100}$/;
const FLOW_TTL_SEC = 600;
const CALLBACK_PATH = "/bff/mcp/callback";

const authKey = (roomId: string, name: string) => ({ pk: roomKey(roomId), sk: `MCPAUTH#${name}` });
const flowKey = (state: string) => ({ pk: `MCPFLOW#${state}`, sk: "META" });
/** The tokens are sealed to their room and connection, so a blob copied into another item won't open there. */
const authAad = (roomId: string, name: string) => `${roomId}#${name}`;

const unknownServer = (name: string) => new NotFound(noSuchServer(name));
const nameTaken = (name: string) => new Conflict(`This room already has an MCP server called ${name}.`);
const needsReconnect = (name: string) => new Conflict(needsReconnecting(name));
const roomFull = () => new Conflict(`A room can connect up to ${MAX_MCP_SERVERS} MCP servers.`);

/** Remote servers fail in many shapes; the admin gets one line naming the host, and a URL we refused stays a 400. */
async function fromRemote<T>(host: string, name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof NeedsAuth || e instanceof UnauthorizedError) throw needsReconnect(name);
    if (e instanceof ValidationError) throw e;
    if (e instanceof UserError) throw new Upstream(e.message);
    throw new Upstream(remoteFailure(host, e));
  }
}

const liveDeps = (): Deps => {
  const hosts = localHosts();
  return { fetch: guardedFetch({ localHosts: hosts }), hosts, key: tokenKey, notifyRoom: roomUpdated };
};

/**
 * A room's remote MCP servers, added by admins. A connection holds the tool list an admin saw when connecting, so a
 * server can't add tools or relabel one read-only without an admin refreshing it. Its OAuth tokens live apart, sealed,
 * versioned so two runs refreshing at once can't overwrite each other.
 */
export function mcpRepo(deps: Deps = liveDeps()) {
  const db = docClient();
  const TableName = tableName();
  const connections = connectionsRepo();

  const audited = (user: User, roomId: string, kind: AuditKind, detail: string) => ({
    Put: { TableName, Item: auditItem(roomId, { id: randomUUID(), at: new Date().toISOString(), actor: user.username, kind, detail }) },
  });

  async function get(roomId: string, name: string): Promise<McpConnection | null> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: mcpConnKey(roomId, name), ConsistentRead: true }));
    return Item ? (withoutKeys(Item) as McpConnection) : null;
  }

  async function existing(roomId: string, name: string): Promise<McpConnection> {
    const conn = await get(roomId, name);
    if (!conn) throw unknownServer(name);
    return conn;
  }

  /** Checked before a sign-in starts and again when it finishes, since several flows can be open at once. */
  async function requireRoomFor(roomId: string, name: string) {
    const all = await mcpConnections(roomId);
    if (all.some((c) => c.name === name)) throw nameTaken(name);
    if (all.length >= MAX_MCP_SERVERS) throw roomFull();
  }

  /**
   * The room's server count on its META, moved in the same transaction as the connection. Counting rows first can't
   * stop two admins adding different servers at once from passing the limit together; this condition can.
   */
  const serverAdded = (roomId: string) => ({
    Update: {
      TableName, Key: { pk: roomKey(roomId), sk: "META" }, UpdateExpression: "ADD mcpCount :one",
      ConditionExpression: "attribute_not_exists(mcpCount) OR mcpCount < :max", ExpressionAttributeValues: { ":one": 1, ":max": MAX_MCP_SERVERS },
    },
  });
  const serverRemoved = (roomId: string) => ({
    Update: { TableName, Key: { pk: roomKey(roomId), sk: "META" }, UpdateExpression: "ADD mcpCount :minus", ExpressionAttributeValues: { ":minus": -1 } },
  });

  function tokenStore(roomId: string, name: string): TokenStore {
    const aad = authAad(roomId, name);
    return {
      async load() {
        const { Item } = await db.send(new GetCommand({ TableName, Key: authKey(roomId, name), ConsistentRead: true }));
        if (!Item) return null;
        try {
          return { auth: JSON.parse(unseal(await deps.key(), String(Item.sealed), aad)) as StoredAuth, version: Number(Item.version) };
        } catch (e) {
          if (e instanceof SealError) return null;
          throw e;
        }
      },
      async save(auth, version) {
        try {
          await db.send(new UpdateCommand({
            TableName, Key: authKey(roomId, name),
            UpdateExpression: "SET sealed = :sealed, #version = :next", ConditionExpression: "#version = :read",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":sealed": seal(await deps.key(), JSON.stringify(auth), aad), ":read": version, ":next": version + 1 },
          }));
          return true;
        } catch (e) {
          if (conditionFailed(e)) return false;
          throw e;
        }
      },
      async markNeedsAuth() {
        try {
          await db.send(new UpdateCommand({
            TableName, Key: mcpConnKey(roomId, name), UpdateExpression: "SET #status = :status", ConditionExpression: "attribute_exists(sk)",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":status": "needs_auth" },
          }));
        } catch (e) {
          if (conditionFailed(e)) return;
          throw e;
        }
        // Best effort: the status is stored, and the panel shows it on its next load.
        await deps.notifyRoom(roomId).catch((e) => console.error("room.updated broadcast failed", roomId, e));
      },
    };
  }

  /**
   * The connection, its sealed tokens and the audit entry, all or nothing. The tokens' version only ever goes up, so
   * a run still holding the tokens from before a reconnect can't save over the new ones.
   */
  async function saveConnected(user: User, roomId: string, server: Server, opts: { reconnect: boolean; auth?: StoredAuth }) {
    const { name } = server;
    if (!opts.reconnect) await requireRoomFor(roomId, name);
    const now = new Date().toISOString();
    const connection: McpConnection = { ...server, status: "connected", toolsAt: now, addedBy: user.username, addedAt: now };
    const sealed = opts.auth && seal(await deps.key(), JSON.stringify(opts.auth), authAad(roomId, name));
    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName, Item: { ...mcpConnKey(roomId, name), ...connection },
              ConditionExpression: opts.reconnect ? "attribute_exists(sk)" : "attribute_not_exists(sk)",
            },
          },
          ...(sealed ? [{
            Update: {
              TableName, Key: authKey(roomId, name), UpdateExpression: "SET sealed = :sealed ADD #version :one",
              ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":sealed": sealed, ":one": 1 },
            },
          }] : []),
          audited(user, roomId, "connected", `MCP ${name} (${new URL(server.url).hostname})`),
          ...(opts.reconnect ? [] : [serverAdded(roomId)]),
        ],
      }));
    } catch (e) {
      if (failedAt(e, 0)) throw opts.reconnect ? unknownServer(name) : nameTaken(name);
      if (!opts.reconnect && failedAt(e, sealed ? 3 : 2)) throw roomFull();
      throw e;
    }
    return connection;
  }

  /**
   * Asks the server how it signs in. One without sign-in is connected at once; for OAuth, the flow's PKCE verifier
   * is sealed under its own state and kept for ten minutes, and the admin is sent to the authorize page.
   */
  async function start(user: User, roomId: string, name: string, url: URL, redirectUri: unknown, reconnect: boolean): Promise<Started> {
    const returnTo = siteCallback(redirectUri, CALLBACK_PATH);
    const { href, hostname } = url;
    const probed = await fromRemote(hostname, name, () => probe(href, deps.fetch));
    if (probed.auth === "none") {
      const listed = await fromRemote(hostname, name, () => listRemoteTools(name, href, undefined, deps.fetch));
      return { connection: await saveConnected(user, roomId, { name, url: href, auth: "none", ...listed }, { reconnect }) };
    }
    // Reusing the client registered before saves a registration, and keeps the server's list of our clients short.
    const known = reconnect ? (await tokenStore(roomId, name).load())?.auth : undefined;
    const { authorizeUrl, state, pending } = await fromRemote(hostname, name, () =>
      beginAuthorization({ url: href, redirectUri: returnTo, probed, known }, deps.fetch, deps.hosts));
    const flow: Flow = { roomId, userId: user.userId, name, url: href, reconnect, pending: seal(await deps.key(), JSON.stringify(pending), state) };
    await db.send(new PutCommand({ TableName, Item: { ...flowKey(state), ...flow, ttl: Math.floor(Date.now() / 1000) + FLOW_TTL_SEC } }));
    return { authorizeUrl };
  }

  /** A state works once, whoever presents it. */
  async function takeFlow(state: unknown): Promise<Flow & { state: string }> {
    const expired = new Gone("This connection attempt expired. Try again.");
    if (typeof state !== "string" || !STATE.test(state)) throw expired;
    return { ...((await takeOnce(flowKey(state), expired)) as Flow), state };
  }

  return {
    get,
    tokenStore,

    async connect(user: User, roomId: string, body: { name: unknown; url: unknown; redirectUri: unknown }) {
      await connections.requireManager(roomId, user.userId, { writing: true });
      const { name } = body;
      if (typeof name !== "string" || !NAME.test(name)) throw new ValidationError("Name it with 1–20 lowercase letters, digits or dashes.");
      const url = mcpServerUrl(body.url, deps.hosts);
      await requireRoomFor(roomId, name);
      return start(user, roomId, name, url, body.redirectUri, false);
    },

    async reconnect(user: User, roomId: string, name: string, redirectUri: unknown) {
      await connections.requireManager(roomId, user.userId, { writing: true });
      const conn = await existing(roomId, name);
      return start(user, roomId, name, mcpServerUrl(conn.url, deps.hosts), redirectUri, true);
    },

    /**
     * Only the admin who started a flow may finish it. Otherwise anyone who got an admin to open a crafted callback
     * link could connect a server signed in as themselves (OAuth CSRF), and the room's agents would act through it.
     */
    async finish(user: User, { state, code, error }: { state?: unknown; code?: unknown; error?: unknown }) {
      const flow = await takeFlow(state);
      try {
        if (flow.userId !== user.userId) throw new Forbidden("Finish connecting as the admin who started it.");
        await connections.requireManager(flow.roomId, user.userId, { writing: true });
        const host = new URL(flow.url).hostname;
        if (error || typeof code !== "string") {
          throw new Upstream(`${host} didn't allow access (${typeof error === "string" ? cut(error, 100) : "no code"}).`);
        }
        const pending = JSON.parse(unseal(await deps.key(), flow.pending, flow.state)) as PendingAuth;
        const { auth, listed } = await fromRemote(host, flow.name, async () => {
          const auth = await completeAuthorization(pending, code, deps.fetch);
          return { auth, listed: await listRemoteTools(flow.name, flow.url, auth.tokens.access_token, deps.fetch) };
        });
        const server: Server = { name: flow.name, url: flow.url, auth: "oauth", ...listed };
        return { roomId: flow.roomId, connection: await saveConnected(user, flow.roomId, server, { reconnect: flow.reconnect, auth }) };
      } catch (e) {
        throw new FlowFailed(flow.roomId, e);
      }
    },

    async refreshTools(user: User, roomId: string, name: string): Promise<McpConnection> {
      await connections.requireManager(roomId, user.userId, { writing: true });
      const conn = await existing(roomId, name);
      const list = (bearer?: string) => listRemoteTools(name, conn.url, bearer, deps.fetch);
      const { tools, toolCount } = await fromRemote(new URL(conn.url).hostname, name, () =>
        conn.auth === "oauth" ? withFreshAuth(tokenStore(roomId, name), deps.fetch, list) : list());
      try {
        const { Attributes } = await db.send(new UpdateCommand({
          TableName, Key: mcpConnKey(roomId, name), ReturnValues: "ALL_NEW", ConditionExpression: "attribute_exists(sk)",
          UpdateExpression: "SET tools = :tools, toolCount = :count, toolsAt = :at, #status = :connected",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":tools": tools, ":count": toolCount, ":at": new Date().toISOString(), ":connected": "connected" },
        }));
        return withoutKeys(Attributes ?? {}) as McpConnection;
      } catch (e) {
        if (conditionFailed(e)) throw unknownServer(name);
        throw e;
      }
    },

    /** The server is asked to forget our tokens first (best effort); ours go whatever it answers. */
    async remove(user: User, roomId: string, name: string) {
      await connections.requireManager(roomId, user.userId, { writing: true });
      const conn = await get(roomId, name);
      if (!conn) return;
      const stored = conn.auth === "oauth" ? await tokenStore(roomId, name).load() : null;
      if (stored) await revokeRemote(stored.auth, deps.fetch);
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName, Key: mcpConnKey(roomId, name), ConditionExpression: "attribute_exists(sk)" } },
            { Delete: { TableName, Key: authKey(roomId, name) } },
            audited(user, roomId, "disconnected", `MCP ${name}`),
            serverRemoved(roomId),
          ],
        }));
      } catch (e) {
        if (!conditionFailed(e)) throw e;
      }
    },
  };
}

export type McpRepo = ReturnType<typeof mcpRepo>;
