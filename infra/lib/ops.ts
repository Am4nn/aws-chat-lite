import { ArnFormat, CfnOutput, Duration, Stack, Token } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";

const NAME = "cl-aws-ops";
const RUNBOOK = "Runbook: docs/runbook-aws.md#when-an-alarm-fires";
const FIVE_MINUTES = Duration.minutes(5);

/**
 * Alarms, the alert email and the ops dashboard, for whatever the stack holds when this runs: every Lambda we named,
 * every HTTP and WebSocket API, every table and distribution, found by sweeping the construct tree. It must run after
 * everything else is added. It is not an IAspect because the dashboard needs every alarm in one place, and aspects that
 * add constructs depend on the order they run in.
 */
export function addOps(stack: Stack, alertEmail: string): void {
  const all = stack.node.findAll();
  // CDK's own helpers (an asset deployment's handler, say) have generated names; only functions we named are ours.
  const fns = all.filter((c): c is lambda.Function => c instanceof lambda.Function)
    .map((fn) => ({ fn, name: (fn.node.defaultChild as lambda.CfnFunction).functionName }))
    .filter((f): f is { fn: lambda.Function; name: string } => !Token.isUnresolved(f.name));
  // An API's name is never missing: CDK falls back to the construct id.
  const httpApis = all.filter((c): c is apigwv2.HttpApi => c instanceof apigwv2.HttpApi).map((api) => ({ api, name: api.httpApiName! }));
  const wsApis = all.filter((c): c is apigwv2.WebSocketApi => c instanceof apigwv2.WebSocketApi).map((api) => ({ api, name: api.webSocketApiName! }));
  const tables = all.filter((c): c is dynamodb.Table => c instanceof dynamodb.Table);
  const distributions = all.filter((c): c is cloudfront.Distribution => c instanceof cloudfront.Distribution);

  const topic = new sns.Topic(stack, "OpsTopic", { topicName: NAME, enforceSSL: true });
  // A topic policy replaces SNS's default one, which is what let same-account services publish. Alarms publish as the
  // CloudWatch service, so it is let back in, for this account's alarms in this region only.
  topic.addToResourcePolicy(new iam.PolicyStatement({
    principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
    actions: ["sns:Publish"],
    resources: [topic.topicArn],
    conditions: {
      ArnLike: { "aws:SourceArn": stack.formatArn({ service: "cloudwatch", resource: "alarm", resourceName: "*", arnFormat: ArnFormat.COLON_RESOURCE_NAME }) },
      StringEquals: { "aws:SourceAccount": stack.account },
    },
  }));
  // AWS mails a confirmation link first; nothing arrives until it is clicked.
  topic.addSubscription(new subs.EmailSubscription(alertEmail));
  const action = new cwActions.SnsAction(topic);

  const alarm = (alarmName: string, metric: cloudwatch.IMetric, threshold: number, feel: string) => {
    const a = new cloudwatch.Alarm(stack, alarmName, {
      alarmName, metric, threshold, alarmDescription: `${feel} ${RUNBOOK}`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    a.addAlarmAction(action);
    a.addOkAction(action);
    return a;
  };
  const sum = { period: FIVE_MINUTES, statistic: "Sum" };
  const alarms = [
    ...fns.map(({ fn, name }) => alarm(`${name}-errors`, fn.metricErrors(sum), 3,
      `${name} failed 3+ times in 5 minutes: whatever it serves is failing for users.`)),
    ...httpApis.map(({ api, name }) => alarm(`${name}-5xx`, api.metricServerError(sum), 5,
      `${name} returned 5+ server errors in 5 minutes: pages and actions fail for users.`)),
    ...wsApis.map(({ api, name }) => alarm(`${name}-integration-errors`, api.metric("IntegrationError", sum), 5,
      `${name} failed to reach its Lambda 5+ times in 5 minutes: messages don't send and live updates stop.`)),
    // Throttles are counted per account: one function using up the concurrency quota throttles all the others.
    alarm("cl-aws-lambda-throttles", lambda.Function.metricAllThrottles(sum), 5,
      "Lambda turned away 5+ calls in 5 minutes because the account ran out of concurrency: users see errors everywhere."),
  ];

  const dashboard = new cloudwatch.Dashboard(stack, "OpsDashboard", { dashboardName: NAME });
  dashboard.addWidgets(new cloudwatch.AlarmStatusWidget({ title: "Alarms", alarms, width: 24 }));
  const row = (graphs: [title: string, metrics: cloudwatch.IMetric[]][]) => {
    const shown = graphs.filter(([, metrics]) => metrics.length);
    if (shown.length) dashboard.addWidgets(...shown.map(([title, left]) => new cloudwatch.GraphWidget({ title, left, width: 24 / shown.length })));
  };
  const p90 = { period: FIVE_MINUTES, statistic: "p90" };
  row([
    ["HTTP requests", httpApis.map(({ api, name }) => api.metricCount({ ...sum, label: name }))],
    ["HTTP 4xx / 5xx", httpApis.flatMap(({ api, name }) => [
      api.metricClientError({ ...sum, label: `${name} 4xx` }), api.metricServerError({ ...sum, label: `${name} 5xx` })])],
    ["HTTP latency p90 (ms)", httpApis.map(({ api, name }) => api.metricLatency({ ...p90, label: name }))],
  ]);
  row([
    ["Socket connects", wsApis.map(({ api, name }) => api.metric("ConnectCount", { ...sum, label: name }))],
    ["Socket messages", wsApis.map(({ api, name }) => api.metric("MessageCount", { ...sum, label: name }))],
    ["Socket integration errors", wsApis.map(({ api, name }) => api.metric("IntegrationError", { ...sum, label: name }))],
  ]);
  row([
    ["Lambda errors", fns.map(({ fn, name }) => fn.metricErrors({ ...sum, label: name }))],
    ["Lambda duration p90 (ms)", fns.map(({ fn, name }) => fn.metricDuration({ ...p90, label: name }))],
    ["Lambda throttles", fns.map(({ fn, name }) => fn.metricThrottles({ ...sum, label: name }))],
    // Against the account's concurrency quota, which every function shares.
    ["Lambda concurrent executions (account)", [lambda.Function.metricAllConcurrentExecutions({ period: FIVE_MINUTES, statistic: "Maximum" })]],
  ]);
  row([
    ["Table consumed capacity", tables.flatMap((t) => [
      t.metricConsumedReadCapacityUnits({ ...sum, label: `${t.node.id} read` }),
      t.metricConsumedWriteCapacityUnits({ ...sum, label: `${t.node.id} write` })])],
    ["Table throttled requests", tables.flatMap((t) => [
      t.metric("ReadThrottleEvents", { ...sum, label: `${t.node.id} read` }),
      t.metric("WriteThrottleEvents", { ...sum, label: `${t.node.id} write` })])],
  ]);
  // CloudFront publishes its metrics in us-east-1 with a Region=Global dimension, which CDK's own distribution metrics
  // leave out; without it the graph is empty. An alarm can only watch its own region, so CloudFront gets no alarm.
  const edge = (d: cloudfront.Distribution, metricName: string, statistic: string, label: string) => new cloudwatch.Metric({
    namespace: "AWS/CloudFront", metricName, dimensionsMap: { DistributionId: d.distributionId, Region: "Global" },
    region: "us-east-1", period: FIVE_MINUTES, statistic, label,
  });
  row([
    ["CloudFront requests", distributions.map((d) => edge(d, "Requests", "Sum", d.node.id))],
    ["CloudFront 5xx error rate (%)", distributions.map((d) => edge(d, "5xxErrorRate", "Average", d.node.id))],
  ]);

  new CfnOutput(stack, "OpsTopicArn", { value: topic.topicArn });
  new CfnOutput(stack, "OpsDashboardUrl", {
    value: `https://${stack.region}.console.aws.amazon.com/cloudwatch/home?region=${stack.region}#dashboards/dashboard/${NAME}`,
  });
}
