import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { callerFromEvent } from "../lib/auth.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { budgetRepo, type BudgetRepo } from "../budget/repo.js";
import { capFromUsd } from "../budget/model.js";
import { idOf } from "../chat/model.js";
import { claimableName, threadName } from "./model.js";
import { threadsRepo, type ThreadsRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/** Threads over HTTP: start one, rename one, and the room's agent budget. No route deletes a thread. */
export function makeHandler(threads: Pick<ThreadsRepo, "createThread" | "rename">, budget: Pick<BudgetRepo, "setCap">) {
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const params = event.pathParameters ?? {};
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      switch (event.routeKey) {
        case "POST /rooms/{roomId}/threads":
          return json(201, await threads.createThread(callerFromEvent(event), params.roomId!, {
            text: body.text, clientId: idOf(body.clientId, "clientId"),
          }));
        case "PATCH /rooms/{roomId}/threads/{threadId}": {
          const name = claimableName(threadName(body.name));
          return json(200, { thread: await threads.rename(callerFromEvent(event), params.roomId!, params.threadId!, name) });
        }
        case "PUT /rooms/{roomId}/budget":
          return json(200, { budget: await budget.setCap(callerFromEvent(event), params.roomId!, capFromUsd(body.capUsd)) });
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
export const handler = (event: Event) => (liveHandler ??= makeHandler(threadsRepo(), budgetRepo()))(event);
