import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { TEST_CONTEXT, buildStack, fnNamed, template } from "./test-templates.js";

const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const ALL_VIEWER_EXCEPT_HOST_HEADER = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
const API_PATHS = ["/mcp", "/oauth/*", "/.well-known/oauth-*"];

const site = () => {
  const [dist] = Object.values(template("aws").findResources("AWS::CloudFront::Distribution")) as any[];
  return dist.Properties.DistributionConfig;
};
const behaviour = (path: string) => site().CacheBehaviors.find((b: any) => b.PathPattern === path);
const originOf = (b: any) => site().Origins.find((o: any) => o.Id === b.TargetOriginId);
const urlOf = (fnName: string) => {
  const { logicalId } = fnNamed(fnName, "aws");
  const [[urlId]] = Object.entries(template("aws").findResources("AWS::Lambda::Url", {
    Properties: { TargetFunctionArn: { "Fn::GetAtt": [logicalId, "Arn"] } },
  }));
  return urlId!;
};
const secretSentTo = (b: any) => originOf(b).OriginCustomHeaders.find((h: any) => h.HeaderName === "x-origin-verify").HeaderValue;

describe("the site behind CloudFront", () => {
  it("serves chat.amanarya.com on the us-east-1 certificate", () => {
    expect(site()).toMatchObject({
      Aliases: ["chat.amanarya.com"],
      ViewerCertificate: { AcmCertificateArn: TEST_CONTEXT.certificateArn, MinimumProtocolVersion: "TLSv1.2_2021", SslSupportMethod: "sni-only" },
      PriceClass: "PriceClass_200",
    });
  });

  it("pages go to the web Lambda, uncached, with the origin secret", () => {
    const pages = site().DefaultCacheBehavior;
    expect(pages).toMatchObject({
      CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER, ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
      FunctionAssociations: [{ EventType: "viewer-request", FunctionARN: expect.anything() }],
    });
    expect(JSON.stringify(originOf(pages).DomainName)).toContain(urlOf("cl-aws-web"));
    expect(originOf(pages).OriginCustomHeaders).toEqual([{ HeaderName: "x-origin-verify", HeaderValue: expect.anything() }]);
    template("aws").hasResourceProperties("AWS::CloudFront::Function", { Name: "cl-aws-forwarded-host" });
  });

  it("has one behaviour per asset path, run stream and API path", () => {
    expect(site().CacheBehaviors.map((b: any) => b.PathPattern).sort())
      .toEqual(["/_next/static/*", "/sw.js", "/pcm-worklet.js", "/icons/*", "/runs/*/stream", ...API_PATHS].sort());
  });

  it("static and public assets come from the web bucket through origin access control", () => {
    for (const path of ["/_next/static/*", "/sw.js", "/pcm-worklet.js", "/icons/*"]) {
      expect(behaviour(path), path).toMatchObject({ CachePolicyId: CACHING_OPTIMIZED, ViewerProtocolPolicy: "redirect-to-https" });
      expect(originOf(behaviour(path)).OriginAccessControlId, path).toBeDefined();
    }
  });

  it("run streams go to the stream Function URL, uncached, uncompressed, with a read timeout above the keepalive", () => {
    const stream = behaviour("/runs/*/stream");
    expect(stream).toMatchObject({
      AllowedMethods: ["GET", "HEAD"], CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER, Compress: false,
    });
    expect(originOf(stream).CustomOriginConfig.OriginReadTimeout).toBe(60);
    expect(JSON.stringify(originOf(stream).DomainName)).toContain(urlOf("cl-aws-stream"));
  });

  it("MCP and OAuth paths go to the HTTP API, uncached, with every method and the origin secret", () => {
    const [apiId] = Object.keys(template("aws").findResources("AWS::ApiGatewayV2::Api", { Properties: { ProtocolType: "HTTP" } }));
    for (const path of API_PATHS) {
      const b = behaviour(path);
      expect(b, path).toMatchObject({
        CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
        AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
      });
      expect(JSON.stringify(originOf(b).DomainName), path).toContain(apiId!);
      expect(secretSentTo(b), path).toEqual(secretSentTo(site().DefaultCacheBehavior));
    }
  });

  it("the OAuth Lambda knows the origin secret on AWS, so it can trust CloudFront's viewer address", () => {
    expect(fnNamed("cl-aws-oauth", "aws").props.Environment.Variables.ORIGIN_VERIFY_SECRET).toEqual(secretSentTo(site().DefaultCacheBehavior));
    expect(fnNamed("cl-local-oauth").props.Environment.Variables).not.toHaveProperty("ORIGIN_VERIFY_SECRET");
  });

  it("the threads Lambda hands out stream URLs on the site", () => {
    expect(fnNamed("cl-aws-threads", "aws").props.Environment.Variables.STREAM_URL).toBe("https://chat.amanarya.com");
  });

  it("the web Lambda runs the Next.js server with the production settings, outlasts an API call, and logs for a month", () => {
    const web = fnNamed("cl-aws-web", "aws").props;
    expect(web).toMatchObject({ MemorySize: 1024, Timeout: 30, Handler: "index.handler", Runtime: "nodejs22.x" });
    expect(Object.keys(web.Environment.Variables).sort()).toEqual(
      ["API_URL", "COGNITO_REGION", "ORIGIN_VERIFY_SECRET", "SECURE_COOKIES", "SIGNUP_EMAIL", "SITE_ORIGINS", "USER_POOL_CLIENT_ID"],
    );
    expect(web.Environment.Variables).toMatchObject({
      SECURE_COOKIES: "true", SIGNUP_EMAIL: "required", SITE_ORIGINS: "https://chat.amanarya.com", COGNITO_REGION: "ap-southeast-2",
      ORIGIN_VERIFY_SECRET: secretSentTo(site().DefaultCacheBehavior),
    });
    const logGroupId = web.LoggingConfig.LogGroup.Ref;
    expect(template("aws").toJSON().Resources[logGroupId].Properties).toEqual({ LogGroupName: "/aws/lambda/cl-aws-web", RetentionInDays: 30 });
  });

  // The service worker comes from the public deploy: a browser checks it for updates on every load, so it must never
  // sit in a cache for long.
  it("assets deploy with the right cache headers and never delete what an open page may still load", () => {
    const deploys = Object.values(template("aws").findResources("Custom::CDKBucketDeployment")).map((d: any) => d.Properties);
    expect(deploys).toHaveLength(2);
    expect(deploys.find((d) => d.DestinationBucketKeyPrefix === "_next/static"))
      .toMatchObject({ SystemMetadata: { "cache-control": "public, max-age=31536000, immutable" }, Prune: false, OutputObjectKeys: false });
    expect(deploys.find((d) => d.DestinationBucketKeyPrefix === undefined))
      .toMatchObject({ SystemMetadata: { "cache-control": "public, max-age=0, must-revalidate" }, Prune: false, OutputObjectKeys: false });
  });

  it("outputs the site URL, the CNAME target and the web Function URL", () => {
    const outputs = template("aws").findOutputs("*");
    expect(outputs.SiteUrl.Value).toBe("https://chat.amanarya.com");
    expect(outputs.DistributionDomain).toBeDefined();
    expect(outputs.WebFunctionUrl).toBeDefined();
  });

  it("refuses to synth without a web build", () => {
    const empty = mkdtempSync(join(tmpdir(), "cl-no-web-"));
    expect(() => buildStack("aws", { webBuild: { serverDir: empty, assetsDir: empty } }))
      .toThrow(/Build the web app first: npm -w web run build:open-next/);
  });

  it("local has no site", () => {
    template().resourceCountIs("AWS::CloudFront::Distribution", 0);
    template().resourceCountIs("Custom::CDKBucketDeployment", 0);
    expect(fnNamed("cl-local-threads").props.Environment.Variables.STREAM_URL).toBe("http://localhost:4600");
    expect(template().findOutputs("SiteUrl")).toEqual({});
  });
});
