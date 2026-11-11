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

const ROUTES = ["POST /rooms/{roomId}/threads", "PATCH /rooms/{roomId}/threads/{threadId}", "PUT /rooms/{roomId}/budget", "POST /runs/{runId}/approvals/{step}"];

const routes = () => Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);

describe("threads API", () => {
  it("has the thread, budget and approval routes, behind the JWT authorizer", () => {
    for (const key of ROUTES) {
      const route = routes().find((p) => p.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route.AuthorizationType, key).toBe("JWT");
    }
  });

  it("no route deletes a thread", () => {
    expect(routes().filter((p) => String(p.RouteKey).startsWith("DELETE /rooms/{roomId}/threads"))).toEqual([]);
  });

  it("the threads Lambda may post to open sockets", () => {
    const [fn] = Object.values(template().findResources("AWS::Lambda::Function", { Properties: { FunctionName: "cl-local-threads" } })) as any[];
    expect(fn.Properties.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
  });
});
