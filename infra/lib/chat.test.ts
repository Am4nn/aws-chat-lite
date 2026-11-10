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

const ROUTES = ["POST /ws/ticket", "GET /rooms/{roomId}/chats/{chatId}/messages"];

const chatFunction = () => {
  const fns = Object.values(template().findResources("AWS::Lambda::Function", { Properties: { FunctionName: "cl-local-chat" } }));
  expect(fns).toHaveLength(1);
  return fns[0] as any;
};

describe("chat API", () => {
  it("has the ticket and history routes, both behind the JWT authorizer", () => {
    const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    for (const key of ROUTES) {
      const route = routes.find((p) => p.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route.AuthorizationType, key).toBe("JWT");
    }
  });

  it("the chat Lambda knows the browser's socket URL (the Floci host locally)", () => {
    const url = chatFunction().Properties.Environment.Variables.WS_URL;
    expect(JSON.stringify(url)).toMatch(/ws:\/\/.*execute-api\.localhost\.floci\.io:4566\/live/);
  });
});
