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
  "PATCH /rooms/{roomId}/chats/{chatId}/prefs", "POST /rooms/{roomId}/leave", "POST /rooms/{roomId}/archive",
];

describe("rooms API", () => {
  const routes = () => {
    const [httpApi] = Object.keys(template().findResources("AWS::ApiGatewayV2::Api", { Properties: { ProtocolType: "HTTP" } }));
    return Object.values(template().findResources("AWS::ApiGatewayV2::Route"))
      .map((r: any) => r.Properties)
      .filter((p) => p.ApiId.Ref === httpApi);
  };

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

  /** Function names whose execution role has a policy allowing DynamoDB writes. */
  const tableWriters = () => {
    const t = template();
    const writerRoles = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p: any) => JSON.stringify(p.Properties.PolicyDocument).includes("dynamodb:PutItem"))
      .flatMap((p: any) => p.Properties.Roles.map((r: any) => r.Ref));
    return Object.values(t.findResources("AWS::Lambda::Function"))
      .filter((f: any) => writerRoles.includes(f.Properties.Role["Fn::GetAtt"][0]))
      .map((f: any) => f.Properties.FunctionName);
  };

  it("only the rooms, chat and live Lambdas get table access (the public health check and sign-up trigger get none)", () => {
    expect(tableWriters().sort()).toEqual(["cl-local-chat", "cl-local-live", "cl-local-rooms"]);
  });

  it("the rooms Lambda may post to open sockets", () => {
    const t = template();
    const [fn] = Object.values(t.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "cl-local-rooms" } })) as any[];
    const role = fn.Properties.Role["Fn::GetAtt"][0];
    const actions = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement.flatMap((s: any) => [s.Action].flat()));
    expect(actions).toContain("execute-api:ManageConnections");
    expect(fn.Properties.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
  });
});
