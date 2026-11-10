import { fileURLToPath } from "node:url";
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { StageConfig } from "./config.js";

/** Path to a handler file in services/src */
export const servicePath = (file: string) =>
  fileURLToPath(new URL(`../../services/src/${file}`, import.meta.url));

export interface CoreStackProps extends StackProps {
  config: StageConfig;
}

/** The app's long-lived stack. Step 1: the table + GET /health; later steps add to it. */
export class CoreStack extends Stack {
  readonly table: dynamodb.Table;
  readonly api: apigwv2.HttpApi;
  readonly stageConfig: StageConfig;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);
    this.stageConfig = props.config;
    const { prefix } = props.config;

    // One table for everything (single-table design), like instagram-lite.
    this.table = new dynamodb.Table(this, "Main", {
      tableName: `${prefix}-main`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.DESTROY, // learning project: destroy leaves nothing behind
    });
    this.table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
    });

    this.api = new apigwv2.HttpApi(this, "Api", { apiName: `${prefix}-api` });
    this.api.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("Health", this.addFunction("health", "health.ts")),
    });

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
    new CfnOutput(this, "TableName", { value: this.table.tableName });
  }

  /** A Lambda from services/src with STAGE + TABLE_NAME env and table read/write. */
  addFunction(name: string, entry: string, opts: { env?: Record<string, string>; timeout?: number } = {}): NodejsFunction {
    const fn = new NodejsFunction(this, `Fn-${name}`, {
      functionName: `${this.stageConfig.prefix}-${name}`,
      entry: servicePath(entry),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(opts.timeout ?? 10),
      environment: { STAGE: this.stageConfig.stage, TABLE_NAME: this.table.tableName, ...opts.env },
      bundling: { minify: true },
    });
    this.table.grantReadWriteData(fn);
    return fn;
  }
}
