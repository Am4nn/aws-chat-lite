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
  "GET /me", "GET /rooms", "POST /rooms", "GET /rooms/{roomId}", "POST /rooms/{roomId}/chats",
  "PATCH /rooms/{roomId}/members/{userId}", "DELETE /rooms/{roomId}/members/{userId}",
  "POST /rooms/{roomId}/invite", "GET /rooms/{roomId}/invite", "DELETE /rooms/{roomId}/invite",
  "GET /invites/{code}", "POST /invites/{code}/accept",
];

describe("rooms API", () => {
  const routes = () => Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);

  it("has every route", () => {
    const keys = routes().map((p) => p.RouteKey);
    for (const k of ROUTES) expect(keys, k).toContain(k);
  });

  it("protects every route with the JWT authorizer except the invite preview and /health", () => {
    for (const p of routes()) {
      const open = p.RouteKey === "GET /invites/{code}" || p.RouteKey === "GET /health";
      expect(p.AuthorizationType ?? "NONE", p.RouteKey).toBe(open ? "NONE" : "JWT");
    }
  });

  it("has exactly one JWT authorizer", () => {
    template().resourcePropertiesCountIs("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT" }, 1);
  });

  it("the rooms Lambda can read and write the table", () => {
    template().hasResourceProperties("AWS::Lambda::Function", { FunctionName: "cl-local-rooms" });
  });
});
