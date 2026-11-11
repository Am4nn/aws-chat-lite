import { describe, it, expect } from "vitest";
import { template } from "./test-templates.js";

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
