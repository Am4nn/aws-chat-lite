import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CoreStack } from "./core-stack.js";
import { loadConfig } from "./config.js";

let cached: Template | undefined;
const template = () => {
  if (cached) return cached;
  const config = loadConfig("local", { AWS_ENDPOINT_URL: "http://localhost:4566" });
  const stack = new CoreStack(new App(), "cl-local-core", { config, env: { account: "000000000000", region: "us-east-1" } });
  return (cached = Template.fromStack(stack));
};

const ROUTES = [
  "GET /rooms/{roomId}/connections", "GET /rooms/{roomId}/connections/github/installations", "PUT /rooms/{roomId}/connections/github",
  "DELETE /rooms/{roomId}/connections/github", "PUT /rooms/{roomId}/approval-timeout", "GET /rooms/{roomId}/audit",
];

const connectionsFn = () => {
  const fns = Object.entries(template().findResources("AWS::Lambda::Function", { Properties: { FunctionName: "cl-local-connections" } }));
  expect(fns).toHaveLength(1);
  return fns[0]! as [string, any];
};

describe("connections API", () => {
  it("one Lambda serves the room's connection, timeout and audit routes, behind the JWT authorizer", () => {
    const [logicalId] = connectionsFn();
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

  it("has 15 s to reach GitHub, knows its tool mode and keys secret, and may tell the room", () => {
    const [, fn] = connectionsFn();
    expect(fn.Properties.Timeout).toBe(15);
    expect(fn.Properties.Environment.Variables).toMatchObject({ TOOL_MODE: "fake", TOOL_KEYS_SECRET: "cl-local-tool-keys" });
    expect(fn.Properties.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
  });
});
