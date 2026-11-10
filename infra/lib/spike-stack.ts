import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { servicePath } from "./core-stack.js";
import type { StageConfig } from "./config.js";

export interface SpikeStackProps extends StackProps {
  config: StageConfig;
}

/**
 * Throwaway stack: the four things chat-lite's design rests on, to prove (or disprove) them on Floci
 * and real AWS. `npm run spike` / `npm run spike:aws` deploy it, check it, destroy it.
 */
export class SpikeStack extends Stack {
  constructor(scope: Construct, id: string, props: SpikeStackProps) {
    super(scope, id, props);
    const p = `${props.config.prefix}-spike`;
    const out = (name: string, value: string) => new CfnOutput(this, name, { value });

    const table = new dynamodb.Table(this, "Table", {
      tableName: `${p}-table`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = (name: string, entry: string, extra: Partial<lambda.FunctionProps> = {}) => {
      const f = new NodejsFunction(this, `Fn-${name}`, {
        functionName: `${p}-${name}`,
        entry: servicePath(entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: Duration.seconds(30),
        environment: { TABLE_NAME: table.tableName },
        bundling: { minify: true },
        ...extra,
      });
      table.grantReadWriteData(f);
      return f;
    };

    // 1. WebSocket API: fan-out with postToConnection (people chat, presence, typing).
    const wsFn = fn("ws", "spike/ws.ts");
    const integration = (name: string) => new WebSocketLambdaIntegration(name, wsFn);
    const ws = new apigwv2.WebSocketApi(this, "Ws", {
      apiName: `${p}-ws`,
      connectRouteOptions: { integration: integration("WsConnectInt") },
      disconnectRouteOptions: { integration: integration("WsDisconnectInt") },
      defaultRouteOptions: { integration: integration("WsDefaultInt") },
    });
    const wsStage = new apigwv2.WebSocketStage(this, "WsStage", { webSocketApi: ws, stageName: "spike", autoDeploy: true });
    wsStage.grantManagementApiAccess(wsFn);
    out("WsUrl", wsStage.url);
    out("WsCallbackUrl", wsStage.callbackUrl);

    // 2. SSE over Lambda response streaming (the agent's resumable output stream).
    const sseFn = fn("sse", "spike/sse.ts");
    const sseUrl = sseFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });
    out("SseFnName", sseFn.functionName);
    out("SseUrl", sseUrl.url);

    // 3. Durable function: checkpointed steps + a wait (agent runs longer than 15 min).
    const durableFn = fn("durable", "spike/durable.ts", {
      durableConfig: { executionTimeout: Duration.minutes(10), retentionPeriod: Duration.days(1) },
    });
    const live = new lambda.Alias(this, "DurableLive", { aliasName: "live", version: durableFn.currentVersion });
    out("DurableFnName", durableFn.functionName);
    out("DurableFnQualifier", live.aliasName);

    // 4. EventBridge Scheduler → Lambda (scheduled agent jobs).
    const target = fn("scheduled", "spike/scheduled.ts");
    const role = new iam.Role(this, "SchedulerRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com") });
    target.grantInvoke(role);
    const group = new scheduler.CfnScheduleGroup(this, "Group", { name: p });
    out("ScheduleTargetFnName", target.functionName);
    out("ScheduleTargetFnArn", target.functionArn);
    out("SchedulerRoleArn", role.roleArn);
    out("SchedulerGroup", group.name!);
    out("TableName", table.tableName);
  }
}
