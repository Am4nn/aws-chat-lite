import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

describe("run stream", () => {
  it("is a 15-minute Lambda behind a streaming Function URL with no IAM auth and CORS for any origin", () => {
    const stream = fnNamed("cl-local-stream");
    expect(stream.props.Timeout).toBe(900);
    const [url] = Object.values(template().findResources("AWS::Lambda::Url")).map((u: any) => u.Properties);
    expect(url).toMatchObject({
      AuthType: "NONE", InvokeMode: "RESPONSE_STREAM", TargetFunctionArn: { "Fn::GetAtt": [stream.logicalId, "Arn"] },
      Cors: { AllowOrigins: ["*"], AllowHeaders: ["last-event-id"], AllowMethods: ["GET"] },
    });
  });

  it("the stream Lambda reads the table and may delete only stream tickets", () => {
    const statements = statementsOf(fnNamed("cl-local-stream"));
    const actions = statements.flatMap((s: any) => [s.Action].flat());
    expect(actions).toContain("dynamodb:Query");
    for (const write of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem"]) expect(actions).not.toContain(write);
    expect(statements.filter((s: any) => [s.Action].flat().includes("dynamodb:DeleteItem"))).toEqual([expect.objectContaining({
      Action: "dynamodb:DeleteItem",
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["STREAMTICKET#*"] } },
    })]);
  });

  it("POST /runs/{runId}/stream-ticket is behind the JWT authorizer, and the stack outputs StreamUrl", () => {
    const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    expect(routes.find((r) => r.RouteKey === "POST /runs/{runId}/stream-ticket")).toMatchObject({ AuthorizationType: "JWT" });
    expect(template().findOutputs("StreamUrl")).not.toEqual({});
  });
});
