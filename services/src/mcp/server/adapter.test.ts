import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { fromResponse, toRequest } from "./adapter.js";

process.env.MCP_BASE_URL = "https://chat.example";

const event = (over: Partial<APIGatewayProxyEventV2> & { method?: string } = {}) => ({
  rawPath: "/mcp", rawQueryString: "", headers: {}, isBase64Encoded: false,
  requestContext: { http: { method: over.method ?? "POST" } }, ...over,
}) as unknown as APIGatewayProxyEventV2;

describe("toRequest", () => {
  it("builds the full URL on the public base, with the query and every header", () => {
    const req = toRequest(event({ rawQueryString: "a=1&b=2", headers: { "content-type": "application/json", authorization: "Bearer t" } }));
    expect(req.url).toBe("https://chat.example/mcp?a=1&b=2");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer t");
    expect(req.headers.get("content-type")).toBe("application/json");
  });

  it("decodes a base64 body", async () => {
    const body = Buffer.from("grant_type=refresh_token&refresh_token=x").toString("base64");
    const req = toRequest(event({ body, isBase64Encoded: true }));
    expect(await req.text()).toBe("grant_type=refresh_token&refresh_token=x");
  });

  it("passes a plain body as it is, and gives a GET none even when the event carries an empty one", async () => {
    expect(await toRequest(event({ body: '{"a":1}' })).text()).toBe('{"a":1}');
    expect(toRequest(event({ method: "GET", body: "" })).body).toBeNull();
  });
});

describe("fromResponse", () => {
  it("keeps the status, the headers and the body", async () => {
    const res = await fromResponse(new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json", "x-a": "1" } }));
    expect(res).toEqual({ statusCode: 201, headers: { "content-type": "application/json", "x-a": "1" }, body: '{"ok":true}' });
  });

  it("an empty answer has an empty body", async () => {
    expect(await fromResponse(new Response(null, { status: 202 }))).toMatchObject({ statusCode: 202, body: "" });
  });
});
