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

interface SpikeStackProps extends StackProps {
  config: StageConfig;
}

/**
 * Throwaway stack holding the four AWS features chat-lite's design rests on, so they can be proven on Floci and on
 * real AWS. `npm run spike` and `npm run spike:aws` deploy it, probe it and destroy it.
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

    // WebSocket API with postToConnection fan-out: people chatting, presence, typing.
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

    // SSE over Lambda response streaming: the agent's resumable output stream.
    const sseFn = fn("sse", "spike/sse.ts");
    const sseUrl = sseFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });
    out("SseFnName", sseFn.functionName);
    out("SseUrl", sseUrl.url);

    // Durable function with checkpointed steps and a wait: agent runs can outlast Lambda's 15-minute limit.
    const durableFn = fn("durable", "spike/durable.ts", {
      durableConfig: { executionTimeout: Duration.minutes(10), retentionPeriod: Duration.days(1) },
    });
    const live = new lambda.Alias(this, "DurableLive", { aliasName: "live", version: durableFn.currentVersion });
    out("DurableFnName", durableFn.functionName);
    out("DurableFnQualifier", live.aliasName);

    // EventBridge Scheduler invoking a Lambda: scheduled agent jobs.
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
