import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

const ROUTE_KEYS = ["$connect", "$disconnect", "$default", "send", "edit", "delete", "react", "typing", "read", "subscribe", "ping", "stop"];

const liveFunction = () => fnNamed("cl-local-live");
const liveStatements = () => statementsOf(liveFunction());

describe("live WebSocket API", () => {
  it("is one WebSocket API cl-local-ws that routes on the frame's action field", () => {
    template().resourcePropertiesCountIs("AWS::ApiGatewayV2::Api", { ProtocolType: "WEBSOCKET" }, 1);
    template().hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "cl-local-ws", ProtocolType: "WEBSOCKET", RouteSelectionExpression: "$request.body.action",
    });
  });

  it("has exactly its 12 route keys", () => {
    const [wsApi] = Object.keys(template().findResources("AWS::ApiGatewayV2::Api", { Properties: { ProtocolType: "WEBSOCKET" } }));
    const keys = Object.values(template().findResources("AWS::ApiGatewayV2::Route"))
      .filter((r: any) => r.Properties.ApiId.Ref === wsApi).map((r: any) => r.Properties.RouteKey);
    expect(keys.sort()).toEqual([...ROUTE_KEYS].sort());
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
    const vars = liveFunction().props.Environment.Variables;
    expect(vars).toMatchObject({ RUN_FN_QUALIFIER: "live" });
    expect(vars.RUN_FN_NAME).toBeDefined();
    const alias = Object.keys(template().findResources("AWS::Lambda::Alias", { Properties: { Name: "live" } }));
    expect(alias).toHaveLength(1);
    expect(liveStatements()).toContainEqual(expect.objectContaining({ Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { Ref: alias[0] } }));
  });

  it("the live Lambda has 29 s, since a send hands its message to the agent after the ack", () => {
    expect(liveFunction().props.Timeout).toBe(29);
  });

  it("may post only to the live stage's connections", () => {
    const manage = liveStatements().filter((s: any) => [s.Action].flat().includes("execute-api:ManageConnections"));
    expect(manage).toHaveLength(1);
    expect(JSON.stringify(manage[0].Resource)).toMatch(/\/live\/POST\/@connections\/\*"/);
  });

  it("the live Lambda posts back through the API's own Floci host locally", () => {
    const url = liveFunction().props.Environment.Variables.WS_CALLBACK_URL;
    expect(JSON.stringify(url)).toMatch(/execute-api\.localhost\.floci\.io:4566\/live/);
  });
});
