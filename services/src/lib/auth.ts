import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

/** All JWT claims of the caller (API Gateway already verified the token). */
export function claimsFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  return (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
}

/** Caller's Cognito user id. */
export function subFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  const sub = claimsFromEvent(event).sub;
  if (typeof sub !== "string" || !sub) throw new Error("no sub claim (route missing JWT authorizer?)");
  return sub;
}

/** Caller's username (ID token claim `cognito:username`). */
export function usernameFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  const u = claimsFromEvent(event)["cognito:username"];
  return typeof u === "string" ? u : "";
}

/** Parses a JSON body; undefined body → {}. Returns null on invalid JSON. */
export function parseBody(event: { body?: string; isBase64Encoded?: boolean }): unknown | null {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
