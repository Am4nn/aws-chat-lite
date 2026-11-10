import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

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
