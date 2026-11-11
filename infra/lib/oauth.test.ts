import { describe, it, expect } from "vitest";
import { fnNamed, template } from "./test-templates.js";

const PUBLIC = [
  "GET /.well-known/oauth-authorization-server", "GET /.well-known/oauth-protected-resource", "GET /.well-known/oauth-protected-resource/mcp",
  "POST /oauth/register", "GET /oauth/authorize", "POST /oauth/token", "POST /oauth/revoke",
];
const SIGNED_IN = ["GET /oauth/requests/{requestId}", "POST /oauth/requests/{requestId}/decision", "GET /me/apps", "DELETE /me/apps/{grantId}"];

const routes = () => Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);

describe("the OAuth authorization server", () => {
  it("one Lambda serves its routes: the ones MCP clients call are public, the consent and app routes need a sign-in", () => {
    const { logicalId } = fnNamed("cl-local-oauth");
    const integrations = template().findResources("AWS::ApiGatewayV2::Integration");
    for (const key of [...PUBLIC, ...SIGNED_IN]) {
      const route = routes().find((p) => p.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route.AuthorizationType, key).toBe(SIGNED_IN.includes(key) ? "JWT" : "NONE");
      const integration = String(route.Target["Fn::Join"][1][1].Ref);
      expect(JSON.stringify(integrations[integration]), key).toContain(logicalId);
    }
  });

  it("has 15 s and the table, and knows its public base and the site", () => {
    const { props } = fnNamed("cl-local-oauth");
    expect(props.Timeout).toBe(15);
    expect(props.Environment.Variables).toMatchObject({ SITE_URL: "http://localhost:3000", TABLE_NAME: { Ref: expect.any(String) } });
    expect(JSON.stringify(props.Environment.Variables.MCP_BASE_URL)).toMatch(/"http:\/\/".*"\.execute-api\.localhost\.floci\.io:4566"/);
    expect(fnNamed("cl-aws-oauth", "aws").props.Environment.Variables).toMatchObject({
      MCP_BASE_URL: "https://chat.amanarya.com", SITE_URL: "https://chat.amanarya.com",
    });
  });

  it("sends no CORS headers: MCP clients call it from servers and apps, never from a browser page", () => {
    const apis = Object.values(template().findResources("AWS::ApiGatewayV2::Api", { Properties: { ProtocolType: "HTTP" } })) as any[];
    expect(apis).toHaveLength(1);
    expect(apis[0].Properties.CorsConfiguration).toBeUndefined();
  });
});
