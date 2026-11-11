import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { decideApproval } from "../approvals/decide.js";
import { callerFromEvent } from "../lib/auth.js";
import { ValidationError } from "../lib/errors.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { budgetRepo, type BudgetRepo } from "../budget/repo.js";
import { capFromUsd } from "../budget/model.js";
import { idOf } from "../chat/model.js";
import { issueStreamTicket } from "../runs/stream-tickets.js";
import { claimableName, threadName } from "./model.js";
import { threadsRepo, type ThreadsRepo } from "./repo.js";
import { startThread } from "./start-thread.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/**
 * Threads over HTTP: start one, rename one, the room's agent budget, the one-time URL that opens a run's event
 * stream, and a member's decision on a write the agent asked to make. No route deletes a thread.
 */
export function makeHandler(
  threads: Pick<ThreadsRepo, "rename">, budget: Pick<BudgetRepo, "setCap">, start: typeof startThread,
  issueTicket: typeof issueStreamTicket, decide: typeof decideApproval,
) {
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const params = event.pathParameters ?? {};
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      switch (event.routeKey) {
        case "POST /rooms/{roomId}/threads": {
          const input = { text: body.text, clientId: idOf(body.clientId, "clientId"), model: body.model };
          return json(201, await start(callerFromEvent(event), params.roomId!, input));
        }
        case "PATCH /rooms/{roomId}/threads/{threadId}": {
          const name = claimableName(threadName(body.name));
          return json(200, { thread: await threads.rename(callerFromEvent(event), params.roomId!, params.threadId!, name) });
        }
        case "PUT /rooms/{roomId}/budget":
          return json(200, { budget: await budget.setCap(callerFromEvent(event), params.roomId!, capFromUsd(body.capUsd)) });
        case "POST /runs/{runId}/stream-ticket": {
          const runId = params.runId!;
          const { ticket } = await issueTicket(callerFromEvent(event), runId);
          // A Function URL ends in a slash.
          const base = (process.env.STREAM_URL ?? "").replace(/\/$/, "");
          return json(200, { url: `${base}/runs/${runId}/stream?ticket=${ticket}` });
        }
        case "POST /runs/{runId}/approvals/{step}": {
          const step = Number(params.step);
          if (!Number.isInteger(step) || step < 1) throw new ValidationError("No such step.");
          if (body.decision !== "approve" && body.decision !== "deny") throw new ValidationError("Decide approve or deny.");
          return json(200, await decide(callerFromEvent(event), params.runId!, step, body.decision));
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
export const handler = (event: Event) =>
  (liveHandler ??= makeHandler(threadsRepo(), budgetRepo(), startThread, issueStreamTicket, decideApproval))(event);
