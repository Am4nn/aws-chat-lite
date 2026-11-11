import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { issuer } from "../../oauth/model.js";

/**
 * The API Gateway event as a web-standard Request, for the SDK's transport. The URL is rebuilt on the public base,
 * because the Host the Lambda sees is API Gateway's own, not the address MCP clients were given.
 */
export function toRequest(event: APIGatewayProxyEventV2): Request {
  const { method } = event.requestContext.http;
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  // A Request with a body on GET or HEAD throws, and API Gateway may send an empty one.
  const body = event.body && method !== "GET" && method !== "HEAD"
    ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body)
    : undefined;
  return new Request(`${issuer()}${event.rawPath}${query}`, { method, headers, body });
}

export async function fromResponse(res: Response): Promise<APIGatewayProxyStructuredResultV2> {
  return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}
