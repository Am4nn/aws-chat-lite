import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { callerFromEvent, subFromEvent } from "../lib/auth.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { OAuthError, authServerMetadata, issuer, resourceMetadata } from "./model.js";
import { oauthRepo, type OAuthRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

/** Answers that carry tokens or client ids must never sit in a cache (RFC 6749 §5.1). */
const noStore = (res: Result): Result => ({ ...res, headers: { ...res.headers, "cache-control": "no-store" } });

const formOf = (event: Event) =>
  new URLSearchParams(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "");

/**
 * The authorization server's public endpoints, which MCP clients call without a chat-lite session, plus the
 * signed-in routes behind the consent page and Connected apps.
 */
export function makeHandler(repo: OAuthRepo) {
  return async (event: Event): Promise<Result> => {
    const ip = event.requestContext.http.sourceIp;
    const param = (name: string) => event.pathParameters?.[name] ?? "";
    try {
      switch (event.routeKey) {
        case "GET /.well-known/oauth-authorization-server":
          return json(200, authServerMetadata(issuer()));
        case "GET /.well-known/oauth-protected-resource":
        case "GET /.well-known/oauth-protected-resource/mcp":
          return json(200, resourceMetadata(issuer()));
        case "POST /oauth/register": {
          const body = parseBody(event);
          if (body === null) throw new OAuthError("invalid_client_metadata", "The body must be JSON.");
          return noStore(json(201, await repo.registerClient(body, ip)));
        }
        case "GET /oauth/authorize": {
          const result = await repo.startRequest(event.queryStringParameters ?? {}, ip);
          if ("error" in result) return { statusCode: result.status, headers: { "content-type": "text/plain; charset=utf-8" }, body: result.error };
          return { statusCode: 302, headers: { location: result.consent } };
        }
        case "POST /oauth/token":
          return noStore(json(200, await repo.token(formOf(event))));
        case "POST /oauth/revoke":
          await repo.revoke(formOf(event));
          return { statusCode: 200 };
        case "GET /oauth/requests/{requestId}":
          return json(200, await repo.getRequest(param("requestId")));
        case "POST /oauth/requests/{requestId}/decision": {
          const body = parseBody(event) as { decision?: unknown } | null;
          if (body === null) return json(400, { error: "Body must be JSON." });
          return json(200, await repo.decide(callerFromEvent(event), param("requestId"), body.decision));
        }
        case "GET /me/apps":
          return json(200, { apps: await repo.listApps(subFromEvent(event)) });
        case "DELETE /me/apps/{grantId}":
          await repo.revokeApp(subFromEvent(event), param("grantId"));
          return { statusCode: 204 };
        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      if (e instanceof OAuthError) return noStore(json(e.status, { error: e.code, error_description: e.message }));
      return errorResponse(e);
    }
  };
}

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (liveHandler ??= makeHandler(oauthRepo()))(event);
