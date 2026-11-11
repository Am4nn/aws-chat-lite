import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { callerFromEvent } from "../../lib/auth.js";
import { errorResponse, json, parseBody } from "../../lib/http.js";
import { roomUpdated } from "../../live/broadcast.js";
import { mcpRepo, type McpRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

/**
 * Room admins add, reconnect, refresh and remove remote MCP servers, and the OAuth return route finishes a sign-in.
 * Changes tell the room's open sockets to refetch (best effort: the change has already been made). Bodies carry the
 * connection and at most an authorize URL; tokens, verifiers and client secrets never leave the table.
 */
export function makeHandler(repo: McpRepo, notifyRoom: (roomId: string) => Promise<unknown>) {
  const changed = async (roomId: string, result: Result) => {
    try {
      await notifyRoom(roomId);
    } catch (e) {
      console.error("room.updated broadcast failed", roomId, e);
    }
    return result;
  };
  // 200 sends the admin to the server's sign-in; 201 means it needed none and is already connected.
  const started = (roomId: string, r: Awaited<ReturnType<McpRepo["connect"]>>) =>
    "authorizeUrl" in r ? json(200, r) : changed(roomId, json(201, r));

  return async (event: Event): Promise<Result> => {
    const roomId = event.pathParameters?.roomId ?? "";
    const name = event.pathParameters?.name ?? "";
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      const user = callerFromEvent(event);
      switch (event.routeKey) {
        case "POST /rooms/{roomId}/connections/mcp":
          return started(roomId, await repo.connect(user, roomId, { name: body.name, url: body.url, redirectUri: body.redirectUri }));
        case "POST /rooms/{roomId}/connections/mcp/{name}/reconnect":
          return started(roomId, await repo.reconnect(user, roomId, name, body.redirectUri));
        case "POST /rooms/{roomId}/connections/mcp/{name}/refresh":
          return changed(roomId, json(200, { connection: await repo.refreshTools(user, roomId, name) }));
        case "DELETE /rooms/{roomId}/connections/mcp/{name}":
          await repo.remove(user, roomId, name);
          return changed(roomId, { statusCode: 204 });
        case "POST /mcp-flows/finish": {
          const done = await repo.finish(user, { state: body.state, code: body.code, error: body.error });
          return changed(done.roomId, json(200, done));
        }
        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (liveHandler ??= makeHandler(mcpRepo(), roomUpdated))(event);
