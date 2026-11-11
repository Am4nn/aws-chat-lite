import { fileURLToPath } from "node:url";
import { ArnFormat, Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { StageConfig } from "./config.js";
import { addAuth, type Auth } from "./auth.js";
import { addRooms } from "./rooms.js";
import { addLive } from "./live.js";
import { addChat } from "./chat.js";
import { addFiles } from "./files.js";
import { addThreads } from "./threads.js";
import { addRuns } from "./runs.js";
import { addStream } from "./stream.js";
import { addConnections } from "./connections.js";
import { addMcpConnections } from "./mcp-connections.js";
import { addMcpServer } from "./mcp-server.js";
import { addOAuth } from "./oauth.js";
import { addSandbox } from "./sandbox.js";
import { addWeb, WEB_BUILD, type WebBuild } from "./web.js";

/** Path to a handler file in services/src */
export const servicePath = (file: string) =>
  fileURLToPath(new URL(`../../services/src/${file}`, import.meta.url));

export interface CoreStackProps extends StackProps {
  config: StageConfig;
  /** The OpenNext build the aws site ships. */
  webBuild?: WebBuild;
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
  /** Where MCP clients reach the OAuth and MCP endpoints: the issuer, and the base of the resource `/mcp`. */
  readonly publicApiUrl: string;

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
    // Floci serves each HTTP API on its own host, as it does the WebSocket API.
    this.publicApiUrl = props.config.isLocal ? `http://${this.api.apiId}.execute-api.localhost.floci.io:4566` : props.config.mcpBaseUrl!;
    this.auth = addAuth(this);
    this.route("GET", "/health", this.addFunction("health", "health.ts"), { public: true });
    this.live = addLive(this);
    this.wsUrl = props.config.isLocal ? `ws://${this.flociWsEndpoint()}` : this.live.stage.url;
    this.allowBroadcast(this.live.liveFn);
    this.allowBroadcast(addRooms(this));
    const files = addChat(this);
    this.runs = addRuns(this);
    addSandbox(this, this.runs.runFn);
    addFiles(this, files);
    // A message sent in a thread over the socket starts or steers its run.
    this.allowRunStart(this.live.liveFn);
    // A stop wakes a run waiting on an approval, as does a decision through the API; a run that finds its approval
    // already decided, or a stop already flagged, wakes itself.
    this.allowRunCallback(this.live.liveFn);
    this.allowRunCallback(this.runs.runFn);
    const threadsFn = addThreads(this);
    this.allowBroadcast(threadsFn);
    this.allowRunStart(threadsFn);
    this.allowRunCallback(threadsFn);
    addConnections(this);
    addMcpConnections(this);
    addOAuth(this);
    addMcpServer(this, files);
    const { streamUrl, functionUrl } = addStream(this);
    threadsFn.addEnvironment("STREAM_URL", streamUrl);
    if (props.config.prod) addWeb(this, props.config.prod, props.webBuild ?? WEB_BUILD, functionUrl);

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
    new CfnOutput(this, "WsUrl", { value: this.wsUrl });
    new CfnOutput(this, "TableName", { value: this.table.tableName });
    new CfnOutput(this, "StreamUrl", { value: streamUrl });
    new CfnOutput(this, "McpBaseUrl", { value: this.publicApiUrl });
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

  /**
   * Lets `fn` post to open sockets (API Gateway's management API). POST only, where CDK's own grant allows every
   * method: nothing here reads a connection's details or closes one.
   */
  allowBroadcast(fn: NodejsFunction) {
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [this.formatArn({
        service: "execute-api", resource: this.live.wsApi.apiId, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        resourceName: `${this.live.stage.stageName}/POST/@connections/*`,
      })],
    }));
    fn.addEnvironment("WS_CALLBACK_URL", this.stageConfig.isLocal ? `http://${this.flociWsEndpoint()}` : this.live.stage.callbackUrl);
  }

  /** Lets `fn` start agent runs: an asynchronous invoke of the run function's alias. */
  allowRunStart(fn: NodejsFunction) {
    this.runs.alias.grantInvoke(fn);
    fn.addEnvironment("RUN_FN_NAME", this.runs.runFn.functionName);
    fn.addEnvironment("RUN_FN_QUALIFIER", this.runs.alias.aliasName);
  }

  /**
   * Lets `fn` wake a run that is waiting on a durable callback. A durable execution's ARN is the run function's
   * qualified ARN plus the execution's path, hence the `:*`. The ARN is built from the function's fixed name: the run
   * function wakes itself too, and its own `functionArn` in its own role policy would be a dependency cycle.
   */
  allowRunCallback(fn: NodejsFunction) {
    const arn = this.formatArn({
      service: "lambda", resource: "function", resourceName: `${this.stageConfig.prefix}-run`, arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:SendDurableExecutionCallbackSuccess"], resources: [arn, `${arn}:*`] }));
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
