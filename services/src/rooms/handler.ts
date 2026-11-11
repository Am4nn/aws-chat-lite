import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { callerFromEvent, claimsFromEvent, subFromEvent } from "../lib/auth.js";
import { broadcastToRoom, sendToUser } from "../live/broadcast.js";
import { isCreator } from "./claims.js";
import { roomsRepo, type RoomsRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/**
 * Rooms API: one Lambda, routed by API Gateway's routeKey. A write that changes what members see (chats, members,
 * archive) tells the room's open sockets, which refetch the room view. That is best effort: the write has already
 * happened, and the event carries no data, so a client that misses it loses nothing it won't get on its next load.
 */
export function makeHandler(repo: RoomsRepo, notifyRoom: (roomId: string, alsoUserId?: string) => Promise<unknown>) {
  const changed = async (statusCode: number, result: unknown, roomId: string, alsoUserId?: string) => {
    try {
      await notifyRoom(roomId, alsoUserId);
    } catch (e) {
      console.error("room.updated broadcast failed", roomId, e);
    }
    return json(statusCode, result);
  };
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const params = event.pathParameters ?? {};
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      switch (event.routeKey) {
        case "GET /invites/{code}":
          return json(200, await repo.previewInvite(params.code!));
        case "GET /me":
          return json(200, { ...callerFromEvent(event), isCreator: isCreator(claimsFromEvent(event)) });
        case "GET /rooms":
          return json(200, { rooms: await repo.listMyRooms(subFromEvent(event)) });
        case "POST /rooms":
          if (!isCreator(claimsFromEvent(event))) return json(403, { error: "Only creators can make rooms." });
          return json(201, await repo.createRoom(callerFromEvent(event), body.name));
        case "GET /rooms/{roomId}":
          return json(200, await repo.getRoomView(params.roomId!, subFromEvent(event)));
        case "POST /rooms/{roomId}/chats":
          return changed(201, await repo.createChat(params.roomId!, subFromEvent(event), body.name), params.roomId!);
        case "PATCH /rooms/{roomId}/chats/{chatId}/prefs":
          return json(200, await repo.setChatPrefs(params.roomId!, subFromEvent(event), params.chatId!, body.muted));
        case "PATCH /rooms/{roomId}/members/{userId}":
          return changed(200, await repo.setRole(params.roomId!, subFromEvent(event), params.userId!, body.role), params.roomId!);
        case "DELETE /rooms/{roomId}/members/{userId}":
          // Like leaving: the room fan-out no longer reaches the removed member, so their sockets are told directly.
          return changed(200, await repo.removeMember(params.roomId!, subFromEvent(event), params.userId!), params.roomId!, params.userId!);
        case "POST /rooms/{roomId}/leave":
          // The room fan-out no longer reaches someone who left, so their other tabs are told directly.
          return changed(200, await repo.leaveRoom(params.roomId!, subFromEvent(event)), params.roomId!, subFromEvent(event));
        case "POST /rooms/{roomId}/archive":
          return changed(200, await repo.archiveRoom(params.roomId!, subFromEvent(event)), params.roomId!);
        case "POST /rooms/{roomId}/invite":
          return json(201, await repo.rotateInvite(params.roomId!, subFromEvent(event)));
        case "GET /rooms/{roomId}/invite":
          return json(200, await repo.getInvite(params.roomId!, subFromEvent(event)));
        case "DELETE /rooms/{roomId}/invite":
          return json(200, await repo.revokeInvite(params.roomId!, subFromEvent(event)));
        case "POST /invites/{code}/accept": {
          const joined = await repo.acceptInvite(params.code!, callerFromEvent(event));
          return changed(200, joined, joined.roomId);
        }
        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return errorResponse(e);
    }
  };
}

function roomUpdated(roomId: string, alsoUserId?: string) {
  const event = { type: "room.updated", roomId };
  return Promise.all([broadcastToRoom(roomId, event), alsoUserId && sendToUser(alsoUserId, event)]);
}

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (liveHandler ??= makeHandler(roomsRepo(), roomUpdated))(event);
