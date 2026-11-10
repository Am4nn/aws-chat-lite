import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { SpikeStack } from "./spike-stack.js";
import { loadConfig } from "./config.js";

let cached: Template | undefined;
const template = () => {
  if (cached) return cached;
  const app = new App();
  const config = loadConfig("local", { AWS_ENDPOINT_URL: "http://localhost:4566" });
  const stack = new SpikeStack(app, "cl-local-spike", { config, env: { account: "000000000000", region: "us-east-1" } });
  return (cached = Template.fromStack(stack));
};

describe("SpikeStack", () => {
  it("has a WebSocket API with $connect, $disconnect and $default routes", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "WEBSOCKET" });
    for (const RouteKey of ["$connect", "$disconnect", "$default"]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey });
    }
  });

  it("has a streaming Function URL for SSE", () => {
    template().hasResourceProperties("AWS::Lambda::Url", { InvokeMode: "RESPONSE_STREAM", AuthType: "NONE" });
  });

  it("has a durable function", () => {
    template().hasResourceProperties("AWS::Lambda::Function", { DurableConfig: Match.objectLike({ ExecutionTimeout: Match.anyValue() }) });
  });

  it("lets EventBridge Scheduler invoke the scheduled target, in its own group", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: "scheduler.amazonaws.com" } })]),
      }),
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Action: "lambda:InvokeFunction" })]) }),
    });
    t.hasResourceProperties("AWS::Scheduler::ScheduleGroup", { Name: "cl-local-spike" });
  });

  it("has no VPC resources", () => {
    expect(Object.values(template().toJSON().Resources).some((r: any) => String(r.Type).startsWith("AWS::EC2::"))).toBe(false);
  });
});
