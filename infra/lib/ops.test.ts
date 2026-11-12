import { describe, it, expect } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { addOps } from "./ops.js";
import { TEST_CONTEXT, template } from "./test-templates.js";

const RUNBOOK = "Runbook: docs/runbook-aws.md#when-an-alarm-fires";

/** A stack with only what the sweep looks for: a function we named, one CDK-style unnamed one, an API and a CDN. */
function bareStack() {
  const stack = new Stack(new App(), "Bare");
  const fn = (id: string, functionName?: string) => new lambda.Function(stack, id, {
    functionName, runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {}"),
  });
  fn("Named", "t-named");
  fn("Unnamed");
  new apigwv2.HttpApi(stack, "Api", { apiName: "t-api" });
  new cloudfront.Distribution(stack, "Cdn", { defaultBehavior: { origin: new origins.HttpOrigin("example.com") } });
  addOps(stack, "t", TEST_CONTEXT.alertEmail);
  return Template.fromStack(stack);
}

const alarms = (t: Template) => Object.entries(t.findResources("AWS::CloudWatch::Alarm")) as [string, any][];
const alarmNamed = (t: Template, name: string) => alarms(t).find(([, a]) => a.Properties.AlarmName === name)?.[1].Properties;

/** The ops dashboard's widgets, with each reference in its body replaced by the logical ID it points at. */
function widgets(t: Template): any[] {
  const [dashboard] = Object.values(t.findResources("AWS::CloudWatch::Dashboard")) as any[];
  const parts: any[] = dashboard.Properties.DashboardBody["Fn::Join"][1];
  return JSON.parse(parts.map((p) => typeof p === "string" ? p : p.Ref ?? p["Fn::GetAtt"][0]).join("")).widgets;
}
const metricsOf = (t: Template, title: string): any[][] => widgets(t).find((w) => w.properties.title === title).properties.metrics;

describe("ops", () => {
  it("alarms every function we named, not CDK's own, and names its own alarms after the stage", () => {
    const t = bareStack();
    const [named] = Object.keys(t.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "t-named" } }));
    const errors = alarms(t).filter(([, a]) => a.Properties.MetricName === "Errors");
    expect(errors).toHaveLength(1);
    expect(errors[0]![1].Properties).toMatchObject({
      AlarmName: "t-named-errors", Namespace: "AWS/Lambda", Dimensions: [{ Name: "FunctionName", Value: { Ref: named } }],
      Statistic: "Sum", Period: 300, Threshold: 3, ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1, TreatMissingData: "notBreaching",
    });
    expect(alarms(t).map(([, a]) => a.Properties.AlarmName).sort()).toEqual(["t-api-5xx", "t-lambda-throttles", "t-named-errors"]);
    expect(alarmNamed(t, "t-lambda-throttles")).toMatchObject({ Namespace: "AWS/Lambda", MetricName: "Throttles", Threshold: 5 });
    expect(alarmNamed(t, "t-lambda-throttles").Dimensions).toBeUndefined();
    t.hasResourceProperties("AWS::CloudWatch::Dashboard", { DashboardName: "t-ops" });
    t.hasResourceProperties("AWS::SNS::Topic", { TopicName: "t-ops" });
  });

  it("every function in the aws stack has its errors alarm", () => {
    const t = template("aws");
    const names = Object.values(t.findResources("AWS::Lambda::Function"))
      .map((f: any) => f.Properties.FunctionName).filter((n): n is string => typeof n === "string");
    expect(names.length).toBeGreaterThan(10);
    expect(names.every((n) => n.startsWith("cl-aws-"))).toBe(true);
    for (const name of names) expect(alarmNamed(t, `${name}-errors`), name).toBeDefined();
    const apis = (type: string) => Object.keys(t.findResources("AWS::ApiGatewayV2::Api", { Properties: { ProtocolType: type } })).length;
    expect(alarms(t)).toHaveLength(names.length + apis("HTTP") + apis("WEBSOCKET") + 1);
  });

  it("the API and socket alarms", () => {
    const t = template("aws");
    expect(alarmNamed(t, "cl-aws-api-5xx")).toMatchObject({ Namespace: "AWS/ApiGateway", MetricName: "5xx", Threshold: 5, Period: 300 });
    // A refused connect is a 4xx from the integration, which anyone holding the socket's URL can cause.
    expect(alarmNamed(t, "cl-aws-ws-execution-errors")).toMatchObject({
      Namespace: "AWS/ApiGateway", MetricName: "ExecutionError", Threshold: 5, Period: 300,
    });
    expect(alarms(t).some(([, a]) => a.Properties.MetricName === "IntegrationError")).toBe(false);
    expect(metricsOf(t, "Socket errors").map((m) => [m[1], m[4].label])).toEqual([
      ["IntegrationError", "cl-aws-ws 4xx/5xx from the Lambda"], ["ExecutionError", "cl-aws-ws couldn't call the Lambda"],
    ]);
  });

  it("every alarm notifies the ops topic both ways", () => {
    const t = template("aws");
    const [topic] = Object.keys(t.findResources("AWS::SNS::Topic", { Properties: { TopicName: "cl-aws-ops" } }));
    expect(topic).toBeDefined();
    for (const [, { Properties: a }] of alarms(t)) {
      expect(a.AlarmActions, a.AlarmName).toEqual([{ Ref: topic }]);
      expect(a.OKActions, a.AlarmName).toEqual([{ Ref: topic }]);
      expect(a.AlarmDescription.endsWith(RUNBOOK), a.AlarmName).toBe(true);
    }
  });

  it("the topic mails the alert address, and only this account's alarms may publish to it, over TLS", () => {
    const t = template("aws");
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: TEST_CONTEXT.alertEmail });
    const [topic] = Object.keys(t.findResources("AWS::SNS::Topic"));
    const [policy] = Object.values(t.findResources("AWS::SNS::TopicPolicy")) as any[];
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(2);
    expect(statements).toContainEqual(expect.objectContaining({
      Effect: "Deny", Action: "sns:Publish", Condition: { Bool: { "aws:SecureTransport": "false" } },
    }));
    expect(statements).toContainEqual(expect.objectContaining({
      Effect: "Allow", Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish", Resource: { Ref: topic },
      Condition: {
        ArnLike: { "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudwatch:ap-southeast-2:000000000000:alarm:*"]] } },
        StringEquals: { "aws:SourceAccount": "000000000000" },
      },
    }));
  });

  it("the dashboard shows every alarm, and the stack outputs its topic and console URL", () => {
    const t = template("aws");
    expect(widgets(t)[0].properties.alarms.sort()).toEqual(alarms(t).map(([logicalId]) => logicalId).sort());
    const [api] = Object.keys(t.findResources("AWS::ApiGatewayV2::Api", { Properties: { Name: "cl-aws-api" } }));
    expect(metricsOf(t, "HTTP latency p90 (ms)")).toEqual([["AWS/ApiGateway", "Latency", "ApiId", api, { label: "cl-aws-api", stat: "p90" }]]);
    expect(metricsOf(t, "Socket connects")).toEqual([["AWS/ApiGateway", "ConnectCount", "ApiId", expect.any(String), { label: "cl-aws-ws", stat: "Sum" }]]);
    expect(metricsOf(t, "Lambda errors").map((m) => m[4].label).sort()).toEqual(
      Object.values(t.findResources("AWS::Lambda::Function")).map((f: any) => f.Properties.FunctionName).filter(Boolean).sort());
    expect(metricsOf(t, "Table throttled requests").map((m) => m[1])).toEqual(["ReadThrottleEvents", "WriteThrottleEvents"]);
    expect(Object.keys(t.findOutputs("OpsTopicArn"))).toHaveLength(1);
    expect(Object.values(t.findOutputs("OpsDashboardUrl"))).toEqual([expect.objectContaining({
      Value: "https://ap-southeast-2.console.aws.amazon.com/cloudwatch/home?region=ap-southeast-2#dashboards/dashboard/cl-aws-ops",
    })]);
  });

  // A dashboard is free only up to 50 metrics; past that it costs $3 a month. Each function adds one (its errors line).
  it("the dashboard charts at most 50 metrics: per function only errors, with throttles and concurrency account-wide", () => {
    const t = template("aws");
    const graphs = widgets(t).filter((w) => w.type === "metric");
    expect(graphs.flatMap((w) => w.properties.metrics).length).toBeLessThanOrEqual(50);
    const lambdaMetrics = graphs.flatMap((w) => w.properties.metrics).filter((m) => m[0] === "AWS/Lambda");
    expect(lambdaMetrics.filter((m) => m[1] !== "Errors").map((m) => [m[1], m.length])).toEqual([
      ["Invocations", 3], ["Throttles", 3], ["ConcurrentExecutions", 3],
    ]);
  });

  it("charts CloudFront from us-east-1, where its metrics live, and gives it no alarm", () => {
    const t = bareStack();
    const [cdn] = Object.keys(t.findResources("AWS::CloudFront::Distribution"));
    expect(metricsOf(t, "CloudFront requests")).toEqual([
      ["AWS/CloudFront", "Requests", "DistributionId", cdn, "Region", "Global", { label: "Cdn", region: "us-east-1", stat: "Sum" }],
    ]);
    expect(metricsOf(t, "CloudFront 5xx error rate (%)")).toEqual([
      ["AWS/CloudFront", "5xxErrorRate", "DistributionId", cdn, "Region", "Global", { label: "Cdn", region: "us-east-1" }],
    ]);
    expect(alarms(t).some(([, a]) => a.Properties.Namespace === "AWS/CloudFront")).toBe(false);
  });

  it("local has no alarms, topic or dashboard", () => {
    const t = template("local");
    for (const type of ["AWS::CloudWatch::Alarm", "AWS::CloudWatch::Dashboard", "AWS::SNS::Topic", "AWS::SNS::Subscription"]) {
      t.resourceCountIs(type, 0);
    }
    expect(t.findOutputs("OpsTopicArn")).toEqual({});
  });
});
