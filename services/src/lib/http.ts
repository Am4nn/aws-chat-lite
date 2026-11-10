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
