import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { subFromEvent } from "../lib/auth.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { subscriptionOf } from "./endpoints.js";
import { pushPublicKey } from "./keys.js";
import { pushRepo, type PushRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/**
 * The browser's side of push: the VAPID public key it subscribes with (null where push has no keys), and saving or
 * forgetting this device. This function can read only the public key's secret; the private key stays with the worker.
 */
export function makeHandler(repo: Pick<PushRepo, "save" | "remove">, publicKey: () => Promise<string | undefined>) {
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      switch (event.routeKey) {
        case "GET /push/key":
          return json(200, { publicKey: (await publicKey()) ?? null });
        case "PUT /me/push": {
          const body = parseBody(event);
          if (body === null) return json(400, { error: "Body must be JSON." });
          return json(200, await repo.save(subFromEvent(event), subscriptionOf(body)));
        }
        case "DELETE /me/push/{id}":
          await repo.remove(subFromEvent(event), event.pathParameters?.id ?? "");
          return { statusCode: 204 };
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
export const handler = (event: Event) => (liveHandler ??= makeHandler(pushRepo(), () => pushPublicKey()))(event);
