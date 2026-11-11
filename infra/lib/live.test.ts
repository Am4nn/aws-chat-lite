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

const ROUTE_KEYS = ["$connect", "$disconnect", "$default", "send", "edit", "delete", "react", "typing", "read", "subscribe", "ping", "stop"];

const liveFunction = () => {
  const fns = Object.entries(template().findResources("AWS::Lambda::Function", { Properties: { FunctionName: "cl-local-live" } }));
  expect(fns).toHaveLength(1);
  return fns[0][1] as any;
};

/** Every statement in the policies attached to the live Lambda's role. */
const liveStatements = () => {
  const role = liveFunction().Properties.Role["Fn::GetAtt"][0];
  return Object.values(template().findResources("AWS::IAM::Policy"))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
};

describe("live WebSocket API", () => {
  it("is one WebSocket API cl-local-ws that routes on the frame's action field", () => {
    template().resourcePropertiesCountIs("AWS::ApiGatewayV2::Api", { ProtocolType: "WEBSOCKET" }, 1);
    template().hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "cl-local-ws", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action",
    });
  });

  it("has all 12 route keys", () => {
    const keys = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties.RouteKey);
    for (const k of ROUTE_KEYS) expect(keys, k).toContain(k);
  });

  it("deploys to the stage live", () => {
    template().hasResourceProperties("AWS::ApiGatewayV2::Stage", { StageName: "live", AutoDeploy: true });
  });

  it("the live Lambda may post to connections and use the table", () => {
    const actions = liveStatements().flatMap((s: any) => [s.Action].flat());
    expect(actions).toContain("execute-api:ManageConnections");
    expect(actions).toContain("dynamodb:PutItem");
  });

  it("the live Lambda may start agent runs, since a message in a thread starts or steers one", () => {
    const vars = liveFunction().Properties.Environment.Variables;
    expect(vars).toMatchObject({ RUN_FN_QUALIFIER: "live" });
    expect(vars.RUN_FN_NAME).toBeDefined();
    expect(liveStatements()).toContainEqual(expect.objectContaining({ Action: "lambda:InvokeFunction", Effect: "Allow" }));
  });

  it("the live Lambda posts back through the API's own Floci host locally", () => {
    const url = liveFunction().Properties.Environment.Variables.WS_CALLBACK_URL;
    expect(JSON.stringify(url)).toMatch(/execute-api\.localhost\.floci\.io:4566\/live/);
  });
});
