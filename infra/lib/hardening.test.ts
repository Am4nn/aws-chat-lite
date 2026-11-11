import { describe, it, expect } from "vitest";
import type { Stage } from "./config.js";
import { template } from "./test-templates.js";

const resources = (stage: Stage, type: string) => Object.entries(template(stage).findResources(type)) as [string, any][];

/** Everything that holds users' data or hand-set keys: the table, the user pool, the files bucket and the secrets. */
const dataStores = (stage: Stage) => [
  ...resources(stage, "AWS::DynamoDB::Table"),
  ...resources(stage, "AWS::Cognito::UserPool"),
  ...resources(stage, "AWS::S3::Bucket").filter(([id]) => id.startsWith("Files")),
  ...resources(stage, "AWS::SecretsManager::Secret"),
];

const stageNamed = (stage: Stage, name: string) => {
  const stages = resources(stage, "AWS::ApiGatewayV2::Stage").filter(([, s]) => s.Properties.StageName === name);
  expect(stages).toHaveLength(1);
  return stages[0]![1].Properties;
};

describe("hardening", () => {
  it("aws keeps users' data past a stack delete", () => {
    const stores = dataStores("aws");
    expect(stores.map(([, r]) => r.Type)).toEqual(expect.arrayContaining(["AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::S3::Bucket"]));
    expect(stores.filter(([, r]) => r.Type === "AWS::SecretsManager::Secret").length).toBeGreaterThanOrEqual(3);
    for (const [id, r] of stores) expect({ id, DeletionPolicy: r.DeletionPolicy, UpdateReplacePolicy: r.UpdateReplacePolicy }).toEqual({ id, DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    const [[, table]] = resources("aws", "AWS::DynamoDB::Table");
    expect(table.Properties).toMatchObject({ TableName: "cl-aws-main", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
  });

  it("local still deletes everything", () => {
    for (const [id, r] of dataStores("local")) expect({ id, DeletionPolicy: r.DeletionPolicy }).toEqual({ id, DeletionPolicy: "Delete" });
    const [[, table]] = resources("local", "AWS::DynamoDB::Table");
    expect(table.Properties.PointInTimeRecoverySpecification).toBeUndefined();
  });

  it("every named aws function logs for a month, to a log group that goes with the stack", () => {
    const fns = resources("aws", "AWS::Lambda::Function").filter(([, f]) => String(f.Properties.FunctionName).startsWith("cl-aws-"));
    expect(fns.length).toBeGreaterThan(10);
    const groups = template("aws").findResources("AWS::Logs::LogGroup");
    for (const [, { Properties: fn }] of fns) {
      const group = groups[fn.LoggingConfig?.LogGroup?.Ref];
      expect({ fn: fn.FunctionName, ...group?.Properties, DeletionPolicy: group?.DeletionPolicy }).toEqual({
        fn: fn.FunctionName, LogGroupName: `/aws/lambda/${fn.FunctionName}`, RetentionInDays: 30, DeletionPolicy: "Delete",
      });
    }
  });

  it("local functions keep Lambda's default logging, and local has no log groups", () => {
    expect(resources("local", "AWS::Lambda::Function").filter(([, f]) => f.Properties.LoggingConfig)).toEqual([]);
    expect(resources("local", "AWS::Logs::LogGroup")).toEqual([]);
  });

  it("aws stages throttle at 50/s, burst 100; local doesn't", () => {
    const throttle = { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 };
    expect(stageNamed("aws", "$default").DefaultRouteSettings).toEqual(throttle);
    expect(stageNamed("aws", "live").DefaultRouteSettings).toEqual(throttle);
    expect(stageNamed("local", "$default").DefaultRouteSettings).toBeUndefined();
    expect(stageNamed("local", "live").DefaultRouteSettings).toBeUndefined();
  });

  it("the HTTP API writes JSON access logs on aws; the socket and local stages write none", () => {
    const { DestinationArn, Format } = stageNamed("aws", "$default").AccessLogSettings;
    const group = template("aws").findResources("AWS::Logs::LogGroup")[DestinationArn["Fn::GetAtt"][0]];
    expect(group).toMatchObject({ Properties: { LogGroupName: "/aws/apigateway/cl-aws-api", RetentionInDays: 30 }, DeletionPolicy: "Delete" });
    expect(Object.values(JSON.parse(Format))).toEqual(expect.arrayContaining([
      "$context.requestId", "$context.routeKey", "$context.status", "$context.integrationErrorMessage",
    ]));
    expect(stageNamed("aws", "live").AccessLogSettings).toBeUndefined();
    expect(stageNamed("local", "$default").AccessLogSettings).toBeUndefined();
  });
});
