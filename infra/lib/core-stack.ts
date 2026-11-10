import { fileURLToPath } from "node:url";
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { StageConfig } from "./config.js";
import { addAuth, type Auth } from "./auth.js";
import { addRooms } from "./rooms.js";
import { addLive } from "./live.js";
import { addChat } from "./chat.js";
import { addThreads } from "./threads.js";
import { addRuns } from "./runs.js";

/** Path to a handler file in services/src */
export const servicePath = (file: string) =>
  fileURLToPath(new URL(`../../services/src/${file}`, import.meta.url));

interface CoreStackProps extends StackProps {
  config: StageConfig;
}

/** The app's long-lived stack: the table, auth, the HTTP API and the Lambdas behind it. */
export class CoreStack extends Stack {
  readonly table: dynamodb.Table;
  readonly api: apigwv2.HttpApi;
  readonly stageConfig: StageConfig;
  readonly auth: Auth;
  readonly live: ReturnType<typeof addLive>;
  readonly runs: ReturnType<typeof addRuns>;
  /** Where browsers open the live socket. */
  readonly wsUrl: string;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);
    this.stageConfig = props.config;
    const { prefix } = props.config;

    // Single-table design: every entity lives in this one table, and gsi1 serves the lookups by user.
    this.table = new dynamodb.Table(this, "Main", {
      tableName: `${prefix}-main`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.DESTROY, // A learning project: `cdk destroy` should leave nothing behind.
    });
    this.table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
    });

    this.api = new apigwv2.HttpApi(this, "Api", { apiName: `${prefix}-api` });
    this.auth = addAuth(this);
    this.route("GET", "/health", this.addFunction("health", "health.ts"), { public: true });
    this.live = addLive(this);
    this.wsUrl = props.config.isLocal ? `ws://${this.flociWsEndpoint()}` : this.live.stage.url;
    this.allowBroadcast(this.live.liveFn);
    this.allowBroadcast(addRooms(this));
    addChat(this);
    this.runs = addRuns(this);
    const threadsFn = addThreads(this);
    this.allowBroadcast(threadsFn);
    this.allowRunStart(threadsFn);

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
    new CfnOutput(this, "WsUrl", { value: this.wsUrl });
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

  /** Lets `fn` post to open sockets (API Gateway's management API). */
  allowBroadcast(fn: NodejsFunction) {
    this.live.stage.grantManagementApiAccess(fn);
    fn.addEnvironment("WS_CALLBACK_URL", this.stageConfig.isLocal ? `http://${this.flociWsEndpoint()}` : this.live.stage.callbackUrl);
  }

  /** Lets `fn` start agent runs: an asynchronous invoke of the run function's alias. */
  allowRunStart(fn: NodejsFunction) {
    this.runs.alias.grantInvoke(fn);
    fn.addEnvironment("RUN_FN_NAME", this.runs.runFn.functionName);
    fn.addEnvironment("RUN_FN_QUALIFIER", this.runs.alias.aliasName);
  }

  /**
   * Floci serves each WebSocket API, sockets and management calls alike, on its own host; the amazonaws.com URLs
   * CloudFormation reports for it don't resolve locally.
   */
  private flociWsEndpoint() {
    return `${this.live.wsApi.apiId}.execute-api.localhost.floci.io:4566/${this.live.stage.stageName}`;
  }

  /**
   * A Lambda from services/src with STAGE and TABLE_NAME set; `props` overrides the defaults and adds environment
   * variables. Table read/write is opt-in, so each function gets least privilege.
   */
  addFunction(name: string, entry: string, opts: { tableAccess?: boolean } = {}, props: Partial<NodejsFunctionProps> = {}): NodejsFunction {
    const fn = new NodejsFunction(this, `Fn-${name}`, {
      functionName: `${this.stageConfig.prefix}-${name}`,
      entry: servicePath(entry),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling: { minify: true },
      ...props,
      environment: { STAGE: this.stageConfig.stage, TABLE_NAME: this.table.tableName, ...props.environment },
    });
    if (opts.tableAccess) this.table.grantReadWriteData(fn);
    return fn;
  }
}
