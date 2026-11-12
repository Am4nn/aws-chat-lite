import { randomBytes, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { auditItem } from "../audit/repo.js";
import { requireMember } from "../rooms/membership.js";
import { formatWait, timeoutMinutes } from "../approvals/model.js";
import type { User } from "../lib/auth.js";
import { conditionFailed, docClient, queryAll, tableName, takeOnce, withoutKeys } from "../lib/db.js";
import { FlowFailed, Forbidden, Gone, Upstream, ValidationError } from "../lib/errors.js";
import { siteCallback } from "../lib/http.js";
import { roomKey, roomMetaKey } from "../lib/keys.js";
import { can } from "../rooms/access.js";
import { cut } from "../tools/cut.js";
import { GitHubError } from "../tools/github/app.js";
import type { AuditKind, GitHubConnection, McpConnection } from "../threads/types.js";
import { pkce, type Installation } from "./github-sign-in.js";

/** A GitHub sign-in between the admin leaving for GitHub and coming back. */
type GitHubFlow = { roomId: string; userId: string; redirectUri: string; verifier: string };
/** Trades a sign-in's code for what the signed-in GitHub account can reach. */
type FindInstallations = (code: string, verifier: string, redirectUri: string) => Promise<Installation[]>;

const DEFAULT_APPROVAL_TIMEOUT_SEC = 7200;
const MAX_REPOS = 20;
const FLOW_TTL_SEC = 600;
const GRANT_TTL_SEC = 900;
const STATE = /^[A-Za-z0-9_-]{1,100}$/;
const CALLBACK_PATH = "/bff/github/callback";

/** Integrations are `LINK#` items, apart from the room's `CONN#` socket subscriptions that every broadcast reads. */
const githubKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "LINK#github" });
const flowKey = (state: string) => ({ pk: `GHFLOW#${state}`, sk: "META" });
/** What one admin's GitHub account can reach, for picking repos in one room. */
const grantKey = (roomId: string, userId: string) => ({ pk: `GHGRANT#${roomId}#${userId}`, sk: "META" });
const nowSec = () => Math.floor(Date.now() / 1000);
const MCP_PREFIX = "LINK#mcp#";
export const mcpConnKey = (roomId: string, name: string) => ({ pk: roomKey(roomId), sk: `${MCP_PREFIX}${name}` });

/** A room's remote MCP servers, in name order. */
export async function mcpConnections(roomId: string): Promise<McpConnection[]> {
  const items = await queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
    ExpressionAttributeValues: { ":pk": roomKey(roomId), ":prefix": MCP_PREFIX },
  });
  return items.map((item) => withoutKeys<McpConnection>(item));
}

/**
 * What a room's agent may reach (its GitHub installation and repos, its remote MCP servers) and how long a write waits
 * for approval. Only admins change them, and each change is written in one transaction with its audit entry, so the log
 * can't miss one.
 */
export function connectionsRepo() {
  const db = docClient();
  const TableName = tableName();

  async function requireManager(roomId: string, userId: string, opts: { writing?: boolean } = {}) {
    const role = await requireMember(roomId, userId, opts);
    if (!can("manageConnections", role)) throw new Forbidden("Only admins can change the room's connections.");
  }

  /** The change plus its audit entry, all or nothing. */
  async function withAudit(user: User, roomId: string, kind: AuditKind, detail: string, change: NonNullable<TransactWriteCommandInput["TransactItems"]>[number]) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), actor: user.username, kind, detail };
    await db.send(new TransactWriteCommand({ TransactItems: [change, { Put: { TableName, Item: auditItem(roomId, entry) } }] }));
  }

  /** Read by the run engine as well as the room's settings, so it checks no one's role. */
  async function get(roomId: string): Promise<{ github: GitHubConnection | null; mcp: McpConnection[]; approvalTimeoutSec: number }> {
    const [conn, mcp, meta] = await Promise.all([
      db.send(new GetCommand({ TableName, Key: githubKey(roomId), ConsistentRead: true })),
      mcpConnections(roomId),
      db.send(new GetCommand({ TableName, Key: roomMetaKey(roomId), ConsistentRead: true })),
    ]);
    const github = conn.Item ? withoutKeys<GitHubConnection>(conn.Item) : null;
    return { github, mcp, approvalTimeoutSec: Number(meta.Item?.approvalTimeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC) };
  }

  /** TTL deletion can lag by days, so the expiry is checked here too. */
  async function granted(roomId: string, userId: string): Promise<Installation[]> {
    const { Item } = await db.send(new GetCommand({ TableName, Key: grantKey(roomId, userId), ConsistentRead: true }));
    if (!Item || Number(Item.ttl) <= nowSec()) throw new Gone("Sign in with GitHub to pick repos.");
    return Item.installations as Installation[];
  }

  return {
    requireManager,
    get,

    /** What a member sees, and whether they may change it. */
    async view(roomId: string, userId: string) {
      const role = await requireMember(roomId, userId);
      return { ...(await get(roomId)), canManage: can("manageConnections", role) };
    },

    /**
     * Starts the GitHub App's user sign-in. The PKCE verifier stays in the flow, kept for ten minutes under its state;
     * only the challenge goes to the browser.
     */
    async startGitHubSignIn(user: User, roomId: string, redirectUri: unknown) {
      await requireManager(roomId, user.userId, { writing: true });
      const returnTo = siteCallback(redirectUri, CALLBACK_PATH);
      const state = randomBytes(32).toString("base64url");
      const { verifier, challenge } = pkce();
      const flow: GitHubFlow = { roomId, userId: user.userId, redirectUri: returnTo, verifier };
      await db.send(new PutCommand({ TableName, Item: { ...flowKey(state), ...flow, ttl: nowSec() + FLOW_TTL_SEC } }));
      return { state, challenge, redirectUri: returnTo };
    },

    /**
     * Only the admin who started a sign-in may finish it: otherwise a crafted callback link could hand an admin's
     * room the installations of whoever made it (OAuth CSRF). What that admin's GitHub account can reach is kept for
     * fifteen minutes, long enough to pick repos; the user token itself is never stored. The starter is checked before
     * the state is used up, so someone else holding the link can't cancel the admin's sign-in.
     */
    async finishGitHubSignIn(user: User, { state, code, error }: { state?: unknown; code?: unknown; error?: unknown }, find: FindInstallations) {
      const expired = new Gone("This GitHub sign-in expired. Try again.");
      if (typeof state !== "string" || !STATE.test(state)) throw expired;
      const { Item } = await db.send(new GetCommand({ TableName, Key: flowKey(state), ConsistentRead: true }));
      if (!Item) throw expired;
      const flow = Item as GitHubFlow;
      if (flow.userId !== user.userId) throw new FlowFailed(flow.roomId, new Forbidden("Finish signing in as the admin who started it."));
      await takeOnce(flowKey(state), expired);
      try {
        await requireManager(flow.roomId, user.userId, { writing: true });
        if (error || typeof code !== "string") {
          console.error("GitHub sign-in came back without a code", flow.roomId, typeof error === "string" ? cut(error, 100) : error);
          throw new Upstream("GitHub didn't allow access.");
        }
        const installations = await find(code, flow.verifier, flow.redirectUri).catch((e) => {
          throw e instanceof GitHubError ? new Upstream(e.message) : e;
        });
        await db.send(new PutCommand({ TableName, Item: { ...grantKey(flow.roomId, user.userId), installations, ttl: nowSec() + GRANT_TTL_SEC } }));
        return { roomId: flow.roomId };
      } catch (e) {
        throw new FlowFailed(flow.roomId, e);
      }
    },

    async installations(roomId: string, userId: string) {
      await requireManager(roomId, userId);
      return granted(roomId, userId);
    },

    /**
     * Picking from what the admin's own GitHub sign-in can reach is what stops a room from naming someone else's
     * installation, or a repo the App was never installed on.
     */
    async setGitHub(user: User, roomId: string, pick: { installationId: unknown; repos: unknown }) {
      await requireManager(roomId, user.userId, { writing: true });
      const installation = (await granted(roomId, user.userId)).find((i) => i.id === pick.installationId);
      const repos = Array.isArray(pick.repos) ? [...new Set<unknown>(pick.repos)] : [];
      const fromInstallation = (r: unknown): r is string => typeof r === "string" && !!installation?.repos.includes(r);
      if (!installation || repos.length < 1 || repos.length > MAX_REPOS || !repos.every(fromInstallation)) {
        throw new ValidationError("Pick repos from that installation.");
      }
      const github: GitHubConnection = {
        installationId: installation.id, account: installation.account, repos, addedBy: user.username, addedAt: new Date().toISOString(),
      };
      await withAudit(user, roomId, "connected", repos.join(", "), { Put: { TableName, Item: { ...githubKey(roomId), ...github } } });
      return github;
    },

    /** Removing a connection that isn't there changes nothing, so it logs nothing. */
    async removeGitHub(user: User, roomId: string) {
      await requireManager(roomId, user.userId, { writing: true });
      try {
        await withAudit(user, roomId, "disconnected", "GitHub", {
          Delete: { TableName, Key: githubKey(roomId), ConditionExpression: "attribute_exists(sk)" },
        });
      } catch (e) {
        if (!conditionFailed(e)) throw e;
      }
    },

    /** Stored in seconds, which is what the durable wait takes. */
    async setApprovalTimeout(user: User, roomId: string, rawMinutes: unknown): Promise<number> {
      const minutes = timeoutMinutes(rawMinutes);
      await requireManager(roomId, user.userId, { writing: true });
      await withAudit(user, roomId, "timeout", formatWait(minutes * 60), {
        Update: {
          TableName, Key: roomMetaKey(roomId), UpdateExpression: "SET approvalTimeoutSec = :sec", ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":sec": minutes * 60 },
        },
      });
      return minutes;
    },
  };
}

export type ConnectionsRepo = ReturnType<typeof connectionsRepo>;
