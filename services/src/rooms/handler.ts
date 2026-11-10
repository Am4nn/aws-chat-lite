import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { json } from "../lib/http.js";
import { claimsFromEvent, parseBody, subFromEvent, usernameFromEvent } from "../lib/auth.js";
import { isCreator } from "./claims.js";
import { Conflict, Forbidden, Gone, NotFound, ValidationError } from "./model.js";
import { roomsRepo, type RoomsRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/** Error class → HTTP status. Anything else is a 500 (logged). */
function toResponse(e: unknown): APIGatewayProxyStructuredResultV2 {
  const msg = (e as Error).message;
  if (e instanceof ValidationError) return json(400, { error: msg });
  if (e instanceof Forbidden) return json(403, { error: msg });
  if (e instanceof NotFound) return json(404, { error: msg });
  if (e instanceof Conflict) return json(409, { error: msg });
  if (e instanceof Gone) return json(410, { error: msg });
  console.error(e);
  return json(500, { error: "Something went wrong." });
}

/** Rooms API: one Lambda, routed by API Gateway's routeKey. */
export function makeHandler(repo: RoomsRepo) {
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const p = event.pathParameters ?? {};
    const body = parseBody(event);
    if (body === null) return json(400, { error: "Body must be JSON." });
    const b = body as Record<string, unknown>;
    try {
      switch (event.routeKey) {
        case "GET /invites/{code}":
          return json(200, await repo.previewInvite(p.code!));
        case "GET /me":
          return json(200, { userId: subFromEvent(event), username: usernameFromEvent(event), isCreator: isCreator(claimsFromEvent(event)) });
        case "GET /rooms":
          return json(200, { rooms: await repo.listMyRooms(subFromEvent(event)) });
        case "POST /rooms":
          if (!isCreator(claimsFromEvent(event))) return json(403, { error: "Only creators can make rooms." });
          return json(201, await repo.createRoom(me(event), b.name));
        case "GET /rooms/{roomId}":
          return json(200, await repo.getRoomView(p.roomId!, subFromEvent(event)));
        case "POST /rooms/{roomId}/chats":
          return json(201, await repo.createChat(p.roomId!, subFromEvent(event), b.name));
        case "PATCH /rooms/{roomId}/members/{userId}":
          return json(200, await repo.setRole(p.roomId!, subFromEvent(event), p.userId!, b.role));
        case "DELETE /rooms/{roomId}/members/{userId}":
          return json(200, await repo.removeMember(p.roomId!, subFromEvent(event), p.userId!));
        case "POST /rooms/{roomId}/invite":
          return json(201, await repo.rotateInvite(p.roomId!, subFromEvent(event)));
        case "GET /rooms/{roomId}/invite":
          return json(200, await repo.getInvite(p.roomId!, subFromEvent(event)));
        case "DELETE /rooms/{roomId}/invite":
          return json(200, await repo.revokeInvite(p.roomId!, subFromEvent(event)));
        case "POST /invites/{code}/accept":
          return json(200, await repo.acceptInvite(p.code!, me(event)));
        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return toResponse(e);
    }
  };
}

const me = (event: Event) => ({ userId: subFromEvent(event), username: usernameFromEvent(event) });

let real: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (real ??= makeHandler(roomsRepo()))(event);
