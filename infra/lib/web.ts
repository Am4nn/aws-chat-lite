import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Fn, RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { ProdSettings } from "./config.js";
import type { CoreStack } from "./core-stack.js";

/** Where OpenNext writes the Next.js server's Lambda bundle and the files a CDN can serve. */
export interface WebBuild { serverDir: string; assetsDir: string }

const openNext = (dir: string) => fileURLToPath(new URL(`../../web/.open-next/${dir}`, import.meta.url));
export const WEB_BUILD: WebBuild = { serverDir: openNext("server-functions/default"), assetsDir: openNext("assets") };

/**
 * A nonce shared by CloudFront and the origins behind it, so they can tell CloudFront's requests from direct ones:
 * the random UUID at the end of the stack's ID, stable for the stack's life. It guards no third-party resource, so it
 * doesn't need Secrets Manager.
 */
export const originSecret = (stack: CoreStack) => Fn.select(2, Fn.split("/", stack.stackId));

/** A Function URL answers only to its own Host, so the site's host travels on in x-forwarded-host for Next.js. */
const FORWARDED_HOST = `function handler(event) {
  var r = event.request;
  if (r.headers.host) r.headers["x-forwarded-host"] = { value: r.headers.host.value };
  return r;
}`;

/**
 * The site: one CloudFront distribution on the domain, in front of
 * - the Next.js server (OpenNext) on a Lambda Function URL, for pages and /bff/*;
 * - the web bucket, for the hashed build files and everything in public/;
 * - the run stream's Function URL, so live runs stream from the site's own origin;
 * - the HTTP API, for the MCP endpoint and its OAuth server, which clients find on the site's domain.
 */
export function addWeb(stack: CoreStack, prod: ProdSettings, build: WebBuild, streamUrl: lambda.FunctionUrl) {
  if (!existsSync(join(build.serverDir, "index.mjs")) || !existsSync(join(build.assetsDir, "_next", "static"))) {
    throw new Error("Build the web app first: npm -w web run build:open-next");
  }
  const { prefix } = stack.stageConfig;
  const site = `https://${prod.domainName}`;
  const secretHeader = { "x-origin-verify": originSecret(stack) };

  const server = new lambda.Function(stack, "WebServer", {
    functionName: `${prefix}-web`,
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromAsset(build.serverDir),
    // Lambda's CPU scales with memory, and server rendering is CPU-bound: 1 GB keeps renders and cold starts quick.
    memorySize: 1024,
    // The BFF waits up to 29 s on an API call, just under the 30 s at which API Gateway gives up on an integration.
    timeout: Duration.seconds(30),
    logGroup: stack.logGroup("WebLogs", `/aws/lambda/${prefix}-web`),
    environment: {
      API_URL: stack.api.apiEndpoint,
      USER_POOL_CLIENT_ID: stack.auth.client.userPoolClientId,
      COGNITO_REGION: stack.region,
      SIGNUP_EMAIL: "required",
      DICTATION: stack.stageConfig.dictation,
      SECURE_COOKIES: "true",
      ...stack.siteOriginsEnvironment(),
      ORIGIN_VERIFY_SECRET: originSecret(stack),
    },
  });
  // Streamed, so a page's loading skeleton and layout reach the browser while its data is still being fetched. OpenNext's
  // streaming wrapper (web/open-next.config.ts) writes the response in the format this invoke mode expects.
  const serverUrl = server.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });

  // Removed with the stack: everything in it comes from the build and ships again with the next deploy.
  const bucket = new s3.Bucket(stack, "Web", {
    bucketName: `${prefix}-web-${stack.account}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  const viewer = {
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
  };
  // Never cached, and every viewer header but Host passes on: a Function URL or API Gateway only answers to its own
  // host. The viewer headers include CloudFront-Viewer-Address, which the OAuth rate limits count.
  const dynamic = {
    ...viewer,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
  };
  const asset: cloudfront.BehaviorOptions = {
    ...viewer, origin: origins.S3BucketOrigin.withOriginAccessControl(bucket), cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
  };
  // OpenNext's server bundle leaves out public/, so each top-level file or directory among the assets gets a behaviour
  // to the bucket. _next is the build's own, and BUILD_ID only marks the build.
  const publicPaths = readdirSync(build.assetsDir, { withFileTypes: true })
    .filter((e) => e.name !== "_next" && e.name !== "BUILD_ID")
    .map((e) => (e.isDirectory() ? `/${e.name}/*` : `/${e.name}`));
  const api: cloudfront.BehaviorOptions = {
    ...dynamic,
    origin: new origins.HttpOrigin(`${stack.api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`, { customHeaders: secretHeader }),
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
  };

  const distribution = new cloudfront.Distribution(stack, "Site", {
    comment: `${prefix} site`,
    domainNames: [prod.domainName],
    certificate: acm.Certificate.fromCertificateArn(stack, "SiteCertificate", prod.certificateArn),
    minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    // Adds the Asian edges, India's among them, to the cheapest set.
    priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    defaultBehavior: {
      ...dynamic,
      // A secret header rather than origin access control: with OAC every POST body must arrive signed with a
      // viewer-computed x-amz-content-sha256, and the BFF's writes come straight from the browser.
      origin: new origins.FunctionUrlOrigin(serverUrl, { customHeaders: secretHeader }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: new cloudfront.Function(stack, "ForwardedHost", {
          functionName: `${prefix}-forwarded-host`,
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(FORWARDED_HOST),
        }),
      }],
    },
    additionalBehaviors: {
      "/_next/static/*": asset,
      ...Object.fromEntries(publicPaths.map((path) => [path, asset])),
      // The ticket in the query is the stream's auth. Compression would buffer the events, and the read timeout must
      // outlast the gap between keepalives.
      "/runs/*/stream": {
        ...dynamic,
        origin: new origins.FunctionUrlOrigin(streamUrl, { readTimeout: Duration.seconds(60) }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: false,
      },
      "/mcp": api,
      "/oauth/*": api,
      "/.well-known/oauth-*": api,
    },
  });

  // Only the hashed build files never change under their name. Nothing is pruned, so a page still open from the last
  // deploy can load its old bundles. The custom resource's reply is capped at 4 KB, too small to list every build file.
  const deploy = (id: string, sources: s3deploy.ISource[], cacheControl: string, destinationKeyPrefix?: string) =>
    new s3deploy.BucketDeployment(stack, id, {
      sources, destinationBucket: bucket, destinationKeyPrefix, cacheControl: [s3deploy.CacheControl.fromString(cacheControl)],
      prune: false, outputObjectKeys: false, memoryLimit: 512,
    });
  const hashed = s3deploy.Source.asset(join(build.assetsDir, "_next", "static"));
  deploy("WebStatic", [hashed], "public, max-age=31536000, immutable", "_next/static");
  deploy("WebPublic", [s3deploy.Source.asset(build.assetsDir, { exclude: ["_next", "BUILD_ID"] })], "public, max-age=0, must-revalidate");

  new CfnOutput(stack, "SiteUrl", { value: site });
  new CfnOutput(stack, "DistributionDomain", { value: distribution.distributionDomainName });
  new CfnOutput(stack, "WebFunctionUrl", { value: serverUrl.url });
}
