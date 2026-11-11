import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Conflict, Forbidden, Gone, NotFound, Unavailable, Upstream, ValidationError } from "./errors.js";

/** JSON response for API Gateway HTTP API (payload v2). */
export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    // No CORS header: browsers never call the API, only the Next.js server does (server-side BFF).
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** The request's JSON body ({} when there is none), or null when it isn't valid JSON. API Gateway may base64-encode it. */
export function parseBody(event: { body?: string; isBase64Encoded?: boolean }): unknown | null {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Error class → HTTP status. Anything else is a 500 (logged). */
export function errorResponse(e: unknown): APIGatewayProxyStructuredResultV2 {
  const msg = (e as Error).message;
  if (e instanceof ValidationError) return json(400, { error: msg });
  if (e instanceof Forbidden) return json(403, { error: msg });
  if (e instanceof NotFound) return json(404, { error: msg });
  if (e instanceof Conflict) return json(409, { error: msg });
  if (e instanceof Gone) return json(410, { error: msg });
  if (e instanceof Upstream) return json(502, { error: msg });
  if (e instanceof Unavailable) return json(503, { error: msg });
  console.error(e);
  return json(500, { error: "Something went wrong." });
}
