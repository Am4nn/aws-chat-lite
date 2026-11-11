import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { auditRepo } from "../audit/repo.js";
import { requireMember } from "../chat/membership.js";
import { callerFromEvent, subFromEvent } from "../lib/auth.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { listInstallations } from "../tools/github/app.js";
import { fakeGitHubFetch, fakeKeys } from "../tools/fake-github.js";
import { toolKeys } from "../tools/keys.js";
import type { ToolEnv } from "../tools/types.js";
import { connectionsRepo, type ConnectionsRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type GitHubApp = () => Promise<Pick<ToolEnv, "fetch" | "keys">>;

/**
 * The room's connections, approval timeout and audit log. Every route checks membership; changes need an admin and
 * tell the room's open sockets to refetch (best effort, like the rooms API: the change has already been made).
 * Responses never carry key material: the App's slug, which is public, is the most of it that leaves.
 */
export function makeHandler(repo: ConnectionsRepo, githubApp: GitHubApp, notifyRoom: (roomId: string) => Promise<unknown>) {
  const changed = async (roomId: string, result: APIGatewayProxyStructuredResultV2) => {
    try {
      await notifyRoom(roomId);
    } catch (e) {
      console.error("room.updated broadcast failed", roomId, e);
    }
    return result;
  };
  const installations = async () => listInstallations(await githubApp());

  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const roomId = event.pathParameters?.roomId ?? "";
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      switch (event.routeKey) {
        case "GET /rooms/{roomId}/connections": {
          const { github, approvalTimeoutSec, canManage } = await repo.view(roomId, subFromEvent(event));
          const slug = (await githubApp()).keys.githubAppSlug;
          return json(200, {
            github, approvalTimeoutMin: Math.round(approvalTimeoutSec / 60), canManage,
            installUrl: slug ? `https://github.com/apps/${slug}/installations/new` : null,
          });
        }
        case "GET /rooms/{roomId}/connections/github/installations":
          await repo.requireManager(roomId, subFromEvent(event));
          return json(200, { installations: await installations() });
        case "PUT /rooms/{roomId}/connections/github": {
          const pick = { installationId: body.installationId, repos: body.repos };
          return changed(roomId, json(200, { github: await repo.setGitHub(callerFromEvent(event), roomId, pick, installations) }));
        }
        case "DELETE /rooms/{roomId}/connections/github":
          await repo.removeGitHub(callerFromEvent(event), roomId);
          return changed(roomId, { statusCode: 204 });
        case "PUT /rooms/{roomId}/approval-timeout":
          return changed(roomId, json(200, { approvalTimeoutMin: await repo.setTimeout(callerFromEvent(event), roomId, body.minutes) }));
        case "GET /rooms/{roomId}/audit":
          await requireMember(roomId, subFromEvent(event));
          return json(200, await auditRepo().list(roomId, event.queryStringParameters?.before));
        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Fake mode answers as a canned GitHub App, so local runs and tests never need a real key or the network. */
const githubApp: GitHubApp = async () =>
  process.env.TOOL_MODE === "live" ? { fetch, keys: await toolKeys() } : { fetch: fakeGitHubFetch, keys: fakeKeys() };

const roomUpdated = (roomId: string) => broadcastToRoom(roomId, { type: "room.updated", roomId });

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (liveHandler ??= makeHandler(connectionsRepo(), githubApp, roomUpdated))(event);
