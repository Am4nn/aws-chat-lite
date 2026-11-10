import { fileURLToPath } from "node:url";
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { StageConfig } from "./config.js";
import { addAuth, type Auth } from "./auth.js";
import { addRooms } from "./rooms.js";

/** Path to a handler file in services/src */
export const servicePath = (file: string) =>
  fileURLToPath(new URL(`../../services/src/${file}`, import.meta.url));

interface CoreStackProps extends StackProps {
  config: StageConfig;
}

/** The app's long-lived stack: table, auth, HTTP API; each step adds its feature. */
export class CoreStack extends Stack {
  readonly table: dynamodb.Table;
  readonly api: apigwv2.HttpApi;
  readonly stageConfig: StageConfig;
  readonly auth: Auth;

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
    this.auth = addAuth(this);
    this.route("GET", "/health", this.addFunction("health", "health.ts"), { public: true });
    addRooms(this);

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
    new CfnOutput(this, "TableName", { value: this.table.tableName });
  }

  /** Adds a route; JWT-protected unless `public`. */
  route(method: string, path: string, fn: lambda.IFunction, opts: { public?: boolean } = {}) {
    this.api.addRoutes({
      path,
      methods: [method as apigwv2.HttpMethod],
      integration: new HttpLambdaIntegration(`Int-${method}-${path}`, fn),
      authorizer: opts.public ? undefined : this.auth.authorizer,
    });
  }

  /** A Lambda from services/src with STAGE + TABLE_NAME env and (by default) table read/write. */
  addFunction(
    name: string, entry: string, opts: { env?: Record<string, string>; timeout?: number; tableAccess?: boolean } = {},
  ): NodejsFunction {
    const fn = new NodejsFunction(this, `Fn-${name}`, {
      functionName: `${this.stageConfig.prefix}-${name}`,
      entry: servicePath(entry),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(opts.timeout ?? 10),
      environment: { STAGE: this.stageConfig.stage, TABLE_NAME: this.table.tableName, ...opts.env },
      bundling: { minify: true },
    });
    if (opts.tableAccess !== false) this.table.grantReadWriteData(fn);
    return fn;
  }
}
