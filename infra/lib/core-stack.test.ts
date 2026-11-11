import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { template } from "./test-templates.js";

describe("CoreStack", () => {
  it("has one table cl-local-main with a NEW_IMAGE stream, TTL and gsi1", () => {
    const t = template();
    t.resourceCountIs("AWS::DynamoDB::Table", 1);
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "cl-local-main",
      BillingMode: "PAY_PER_REQUEST",
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "gsi1" })],
    });
  });

  it("routes GET /health to a Lambda", () => {
    const t = template();
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /health" });
    t.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "cl-local-health", Runtime: "nodejs22.x" });
  });

  it("has no VPC resources", () => {
    expect(Object.values(template().toJSON().Resources).some((r: any) => String(r.Type).startsWith("AWS::EC2::"))).toBe(false);
  });
});
