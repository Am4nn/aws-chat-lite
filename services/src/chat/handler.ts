import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { callerFromEvent } from "../lib/auth.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { issueTicket } from "../live/tickets.js";
import { presignUpload } from "./files.js";
import { requireMember } from "./membership.js";
import { seqNumber } from "./model.js";
import { chatRepo, type ChatRepo } from "./repo.js";
import { searchRoom } from "./search.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type User = ReturnType<typeof callerFromEvent>;

interface Deps {
  history: ChatRepo["history"];
  issueTicket: typeof issueTicket;
  searchRoom: typeof searchRoom;
  uploadForm: (user: User, roomId: string, file: unknown) => ReturnType<typeof presignUpload>;
}

// Number("") is 0, so an empty cursor would silently read from the start instead of being refused.
const cursor = (raw: string | undefined) => (raw === undefined ? undefined : seqNumber(raw === "" ? NaN : Number(raw)));

/**
 * Chat over HTTP: the ticket that lets a browser open the live socket, the message history the socket can't replay
 * (first load, older pages, and whatever arrived while a client was offline), search, and upload forms.
 */
export function makeHandler(deps: Deps) {
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const params = event.pathParameters ?? {};
    const query = event.queryStringParameters ?? {};
    const body = parseBody(event);
    if (body === null) return json(400, { error: "Body must be JSON." });
    try {
      switch (event.routeKey) {
        case "POST /ws/ticket":
          return json(200, { ...(await deps.issueTicket(callerFromEvent(event))), url: process.env.WS_URL });
        case "GET /rooms/{roomId}/chats/{chatId}/messages":
          return json(200, await deps.history(callerFromEvent(event), params.roomId!, params.chatId!, {
            before: cursor(query.before), after: cursor(query.after), around: cursor(query.around),
          }));
        case "GET /rooms/{roomId}/search":
          return json(200, await deps.searchRoom(callerFromEvent(event), params.roomId!, query.q));
        case "POST /rooms/{roomId}/attachments":
          return json(200, await deps.uploadForm(callerFromEvent(event), params.roomId!, body));
        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Only someone who may post in the room gets a form to upload into it. */
async function uploadForm(user: User, roomId: string, file: unknown) {
  await requireMember(roomId, user.userId, { writing: true });
  return presignUpload(roomId, user.userId, file);
}

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) =>
  (liveHandler ??= makeHandler({ history: chatRepo().history, issueTicket, searchRoom, uploadForm }))(event);
