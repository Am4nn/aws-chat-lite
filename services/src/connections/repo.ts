import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { auditItem } from "../audit/repo.js";
import { requireMember } from "../chat/membership.js";
import { formatWait, timeoutMinutes } from "../approvals/model.js";
import type { User } from "../lib/auth.js";
import { conditionFailed, docClient, queryAll, tableName } from "../lib/db.js";
import { Forbidden, ValidationError } from "../lib/errors.js";
import { roomKey } from "../lib/keys.js";
import { can } from "../rooms/access.js";
import type { AuditKind, GitHubConnection, McpConnection } from "../threads/types.js";

type Installation = { id: number; account: string; repos: string[] };

const DEFAULT_APPROVAL_TIMEOUT_SEC = 7200;
const MAX_REPOS = 20;

const githubKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "CONN#github" });
const metaKey = (roomId: string) => ({ pk: roomKey(roomId), sk: "META" });
const MCP_PREFIX = "CONN#mcp#";
export const mcpConnKey = (roomId: string, name: string) => ({ pk: roomKey(roomId), sk: `${MCP_PREFIX}${name}` });

export const withoutKeys = ({ pk: _pk, sk: _sk, ...rest }: Record<string, unknown>) => rest;

/** A room's remote MCP servers, in name order. */
export async function mcpConnections(roomId: string): Promise<McpConnection[]> {
  const items = await queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
    ExpressionAttributeValues: { ":pk": roomKey(roomId), ":prefix": MCP_PREFIX },
  });
  return items.map((item) => withoutKeys(item) as McpConnection);
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
      db.send(new GetCommand({ TableName, Key: metaKey(roomId), ConsistentRead: true })),
    ]);
    const github = conn.Item ? (withoutKeys(conn.Item) as GitHubConnection) : null;
    return { github, mcp, approvalTimeoutSec: Number(meta.Item?.approvalTimeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC) };
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
     * `installations` is loaded only after the role check, so a member's request never reaches GitHub. Picking from
     * what the App can see is what stops a room from naming a repo the App was never installed on.
     */
    async setGitHub(user: User, roomId: string, pick: { installationId: unknown; repos: unknown }, installations: () => Promise<Installation[]>) {
      await requireManager(roomId, user.userId, { writing: true });
      const installation = (await installations()).find((i) => i.id === pick.installationId);
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
    async setTimeout(user: User, roomId: string, rawMinutes: unknown): Promise<number> {
      const minutes = timeoutMinutes(rawMinutes);
      await requireManager(roomId, user.userId, { writing: true });
      await withAudit(user, roomId, "timeout", formatWait(minutes * 60), {
        Update: {
          TableName, Key: metaKey(roomId), UpdateExpression: "SET approvalTimeoutSec = :sec", ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":sec": minutes * 60 },
        },
      });
      return minutes;
    },
  };
}

export type ConnectionsRepo = ReturnType<typeof connectionsRepo>;
