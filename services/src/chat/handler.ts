import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { callerFromEvent } from "../lib/auth.js";
import { errorResponse, json } from "../lib/http.js";
import { issueTicket } from "../live/tickets.js";
import { seqNumber } from "./model.js";
import { chatRepo, type ChatRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

const cursor = (raw: string | undefined) => (raw === undefined ? undefined : seqNumber(Number(raw)));

/**
 * Chat over HTTP: the ticket that lets a browser open the live socket, and the message history the socket can't
 * replay (first load, older pages, and whatever arrived while a client was offline).
 */
export function makeHandler(repo: Pick<ChatRepo, "history">, issue: typeof issueTicket) {
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const params = event.pathParameters ?? {};
    const query = event.queryStringParameters ?? {};
    try {
      switch (event.routeKey) {
        case "POST /ws/ticket":
          return json(200, { ...(await issue(callerFromEvent(event))), url: process.env.WS_URL });
        case "GET /rooms/{roomId}/chats/{chatId}/messages":
          return json(200, await repo.history(callerFromEvent(event), params.roomId!, params.chatId!, {
            before: cursor(query.before), after: cursor(query.after), around: cursor(query.around),
          }));
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
export const handler = (event: Event) => (liveHandler ??= makeHandler(chatRepo(), issueTicket))(event);
