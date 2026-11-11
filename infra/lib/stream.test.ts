import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CoreStack } from "./core-stack.js";
import { loadConfig } from "./config.js";

const cache: Record<string, Template> = {};
const template = (stage: "local" | "aws" = "local") => {
  if (cache[stage]) return cache[stage];
  const env = stage === "local" ? { AWS_ENDPOINT_URL: "http://localhost:4566" } : {};
  const config = loadConfig(stage, env);
  const stack = new CoreStack(new App(), `cl-${stage}-core`, { config, env: { account: "000000000000", region: config.region } });
  return (cache[stage] = Template.fromStack(stack));
};

const fnNamed = (name: string, stage: "local" | "aws" = "local") => {
  const fns = Object.entries(template(stage).findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }));
  expect(fns).toHaveLength(1);
  const [logicalId, fn] = fns[0]! as [string, any];
  return { logicalId, props: fn.Properties };
};

const statementsOf = (fn: { props: any }) => {
  const role = fn.props.Role["Fn::GetAtt"][0];
  return Object.values(template().findResources("AWS::IAM::Policy"))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
};

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

  it("the threads Lambda hands out URLs on the local stream server locally and on the Function URL on AWS", () => {
    expect(fnNamed("cl-local-threads").props.Environment.Variables.STREAM_URL).toBe("http://localhost:4600");
    const [urlId] = Object.keys(template("aws").findResources("AWS::Lambda::Url"));
    expect(fnNamed("cl-aws-threads", "aws").props.Environment.Variables.STREAM_URL).toEqual({ "Fn::GetAtt": [urlId, "FunctionUrl"] });
  });

  it("POST /runs/{runId}/stream-ticket is behind the JWT authorizer, and the stack outputs StreamUrl", () => {
    const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    expect(routes.find((r) => r.RouteKey === "POST /runs/{runId}/stream-ticket")).toMatchObject({ AuthorizationType: "JWT" });
    expect(template().findOutputs("StreamUrl")).not.toEqual({});
  });
});
