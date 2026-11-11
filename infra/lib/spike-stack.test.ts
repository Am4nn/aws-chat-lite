import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { spikeTemplate } from "./test-templates.js";

describe("SpikeStack", () => {
  it("has a WebSocket API with $connect, $disconnect and $default routes", () => {
    const t = spikeTemplate();
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "WEBSOCKET" });
    for (const RouteKey of ["$connect", "$disconnect", "$default"]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey });
    }
  });

  it("has a streaming Function URL for SSE", () => {
    spikeTemplate().hasResourceProperties("AWS::Lambda::Url", { InvokeMode: "RESPONSE_STREAM", AuthType: "NONE" });
  });

  it("has a durable function", () => {
    spikeTemplate().hasResourceProperties("AWS::Lambda::Function", { DurableConfig: Match.objectLike({ ExecutionTimeout: Match.anyValue() }) });
  });

  it("lets EventBridge Scheduler invoke the scheduled target, in its own group", () => {
    const t = spikeTemplate();
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
    expect(Object.values(spikeTemplate().toJSON().Resources).some((r: any) => String(r.Type).startsWith("AWS::EC2::"))).toBe(false);
  });
});
