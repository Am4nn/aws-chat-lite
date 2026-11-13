import { describe, it, expect } from "vitest";
import { fnNamed, template } from "./test-templates.js";

const ROUTES = [
  "GET /rooms/{roomId}/connections", "GET /rooms/{roomId}/connections/github/installations", "PUT /rooms/{roomId}/connections/github",
  "DELETE /rooms/{roomId}/connections/github", "PUT /rooms/{roomId}/approval-timeout", "PUT /rooms/{roomId}/approval-mode", "PUT /rooms/{roomId}/post-cap", "GET /rooms/{roomId}/audit",
  "POST /rooms/{roomId}/connections/github/sign-in", "POST /github-flows/finish",
];

describe("connections API", () => {
  it("one Lambda serves the room's connection, GitHub sign-in, timeout and audit routes, behind the JWT authorizer", () => {
    const { logicalId } = fnNamed("cl-local-connections");
    const integrations = template().findResources("AWS::ApiGatewayV2::Integration");
    const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    for (const key of ROUTES) {
      const route = routes.find((p) => p.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route.AuthorizationType, key).toBe("JWT");
      const integration = String(route.Target["Fn::Join"][1][1].Ref);
      expect(JSON.stringify(integrations[integration]), key).toContain(logicalId);
    }
  });

  it("has 15 s to reach GitHub, knows its tool mode, keys secret and the site's origins, and may tell the room", () => {
    const { props } = fnNamed("cl-local-connections");
    expect(props.Timeout).toBe(15);
    expect(props.Environment.Variables).toMatchObject({ TOOL_MODE: "fake", TOOL_KEYS_SECRET: "cl-local-tool-keys", SITE_ORIGINS: expect.stringContaining("http://localhost:3000") });
    expect(props.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
  });
});
