import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { auditRepo } from "../audit/repo.js";
import { requireMember } from "../rooms/membership.js";
import { callerFromEvent, subFromEvent } from "../lib/auth.js";
import { Conflict } from "../lib/errors.js";
import { bestEffort } from "../lib/best-effort.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { roomUpdated } from "../live/broadcast.js";
import { fakeSignInPage } from "../tools/fake-github.js";
import { toolEnv } from "../tools/index.js";
import type { ToolEnv } from "../tools/types.js";
import { githubSignInPage, userInstallations, type SignIn } from "./github-sign-in.js";
import { connectionsRepo, type ConnectionsRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type GitHubApp = () => Promise<Pick<ToolEnv, "fetch" | "keys">>;

/**
 * The room's connections, approval timeout and audit log, and the GitHub sign-in an admin goes through before picking
 * repos. Every route checks membership; changes need an admin and tell the room's open sockets to refetch (best
 * effort, like the rooms API: the change has already been made). Responses never carry key material or the user's
 * GitHub token: the App's slug, which is public, is the most of it that leaves.
 */
export function makeHandler(
  repo: ConnectionsRepo, githubApp: GitHubApp, notifyRoom: (roomId: string) => Promise<unknown>, signInPage: (signIn: SignIn) => string,
) {
  const changed = async (roomId: string, result: APIGatewayProxyStructuredResultV2) => {
    await bestEffort("room.updated broadcast", () => notifyRoom(roomId));
    return result;
  };

  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const roomId = event.pathParameters?.roomId ?? "";
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      switch (event.routeKey) {
        case "GET /rooms/{roomId}/connections": {
          const { github, mcp, approvalTimeoutSec, approvalMode, postCap, canManage } = await repo.view(roomId, subFromEvent(event));
          const slug = (await githubApp()).keys.githubAppSlug;
          return json(200, {
            github, mcp, approvalTimeoutMin: Math.round(approvalTimeoutSec / 60), approvalMode, postCap, canManage,
            installUrl: slug ? `https://github.com/apps/${slug}/installations/new` : null,
          });
        }
        case "POST /rooms/{roomId}/connections/github/sign-in": {
          const clientId = (await githubApp()).keys.githubClientId;
          if (!clientId) throw new Conflict("GitHub sign-in isn't set up here (no App client id).");
          const started = await repo.startGitHubSignIn(callerFromEvent(event), roomId, body.redirectUri);
          return json(200, { authorizeUrl: signInPage({ clientId, ...started }) });
        }
        case "POST /github-flows/finish": {
          const answer = { state: body.state, code: body.code, error: body.error };
          return json(200, await repo.finishGitHubSignIn(callerFromEvent(event), answer, async (code, verifier, redirectUri) =>
            userInstallations(await githubApp(), code, verifier, redirectUri)));
        }
        case "GET /rooms/{roomId}/connections/github/installations":
          return json(200, { installations: await repo.installations(roomId, subFromEvent(event)) });
        case "PUT /rooms/{roomId}/connections/github": {
          const pick = { installationId: body.installationId, repos: body.repos };
          return changed(roomId, json(200, { github: await repo.setGitHub(callerFromEvent(event), roomId, pick) }));
        }
        case "DELETE /rooms/{roomId}/connections/github":
          await repo.removeGitHub(callerFromEvent(event), roomId);
          return changed(roomId, { statusCode: 204 });
        case "PUT /rooms/{roomId}/approval-timeout":
          return changed(roomId, json(200, { approvalTimeoutMin: await repo.setApprovalTimeout(callerFromEvent(event), roomId, body.minutes) }));
        case "PUT /rooms/{roomId}/approval-mode":
          return changed(roomId, json(200, { approvalMode: await repo.setApprovalMode(callerFromEvent(event), roomId, body.mode) }));
        case "PUT /rooms/{roomId}/post-cap":
          return changed(roomId, json(200, { postCap: await repo.setPostCap(callerFromEvent(event), roomId, body.cap) }));
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

// Fake mode has no GitHub page to send the browser to: it comes straight back with a code the fake GitHub takes.
const signInPage = process.env.TOOL_MODE === "live" ? githubSignInPage : fakeSignInPage;

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (liveHandler ??= makeHandler(connectionsRepo(), toolEnv, roomUpdated, signInPage))(event);
