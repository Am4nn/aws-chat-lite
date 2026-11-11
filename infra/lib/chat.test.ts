import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CoreStack } from "./core-stack.js";
import { loadConfig } from "./config.js";

let cached: Template | undefined;
const template = () => {
  if (cached) return cached;
  const config = loadConfig("local", { AWS_ENDPOINT_URL: "http://localhost:4566" });
  const stack = new CoreStack(new App(), "cl-local-core", { config, env: { account: "000000000000", region: "us-east-1" } });
  return (cached = Template.fromStack(stack));
};

const ROUTES = [
  "POST /live/ticket", "GET /rooms/{roomId}/chats/{chatId}/messages", "POST /rooms/{roomId}/attachments", "GET /rooms/{roomId}/search",
];

const fn = (name: string) => {
  const fns = Object.values(template().findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }));
  expect(fns).toHaveLength(1);
  return fns[0] as any;
};
const chatFunction = () => fn("cl-local-chat");

/** Every statement in the policies attached to the function's execution role. */
const statements = (name: string) => {
  const role = fn(name).Properties.Role["Fn::GetAtt"][0];
  return Object.values(template().findResources("AWS::IAM::Policy"))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
};
const s3Statements = (name: string) => statements(name).filter((s: any) => JSON.stringify(s.Resource).includes("Files"));
const s3Actions = (name: string) => s3Statements(name).flatMap((s: any) => [s.Action].flat());
const tableActions = (name: string) => statements(name)
  .filter((s: any) => JSON.stringify(s.Resource).includes("Main")).flatMap((s: any) => [s.Action].flat());

describe("chat API", () => {
  it("has the ticket and history routes, both behind the JWT authorizer", () => {
    const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    for (const key of ROUTES) {
      const route = routes.find((p) => p.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route.AuthorizationType, key).toBe("JWT");
    }
  });

  it("the chat Lambda knows the browser's socket URL (the Floci host locally)", () => {
    const url = chatFunction().Properties.Environment.Variables.WS_URL;
    expect(JSON.stringify(url)).toMatch(/ws:\/\/.*execute-api\.localhost\.floci\.io:4566\/live/);
  });

  it("the files bucket is private, deleted on destroy locally, and takes uploads from the site's origins", () => {
    const [bucket] = Object.values(template().findResources("AWS::S3::Bucket", { Properties: { BucketName: "cl-local-files" } })) as any[];
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    expect(bucket.DeletionPolicy).toBe("Delete");
    template().resourceCountIs("Custom::S3AutoDeleteObjects", 0);
    expect(bucket.Properties.CorsConfiguration.CorsRules).toEqual([expect.objectContaining({
      AllowedMethods: ["POST", "GET"], AllowedOrigins: ["http://localhost:3000", "http://localhost:3100"],
    })]);
  });

  it("the chat Lambda signs uploads and downloads; the live Lambda signs downloads only; both only under rooms/", () => {
    expect(s3Actions("cl-local-chat")).toContain("s3:PutObject");
    expect(s3Actions("cl-local-chat")).toContain("s3:GetObject");
    expect(s3Actions("cl-local-live")).toEqual(["s3:GetObject"]);
    expect(s3Actions("cl-local-chat").filter((a: string) => /List|GetBucket|Delete/.test(a))).toEqual([]);
    for (const name of ["cl-local-chat", "cl-local-live"]) {
      for (const s of s3Statements(name)) expect(JSON.stringify(s.Resource), name).toMatch(/\/rooms\/\*"/);
    }
  });

  it("the chat Lambda only reads the table, except the put that issues a socket ticket", () => {
    const actions = tableActions("cl-local-chat");
    expect(actions).toContain("dynamodb:PutItem");
    expect(actions).toContain("dynamodb:Query");
    expect(actions.filter((a: string) => /UpdateItem|DeleteItem|BatchWriteItem/.test(a))).toEqual([]);
  });

  it("on AWS the files bucket's name carries the account, since S3 names are global", () => {
    const config = loadConfig("aws", {});
    const stack = new CoreStack(new App(), "cl-aws-core", { config, env: { account: "123456789012", region: config.region } });
    Template.fromStack(stack).hasResourceProperties("AWS::S3::Bucket", { BucketName: "cl-aws-files-123456789012" });
  });

  it("both sign URLs for the browser's view of S3 (Floci's host locally)", () => {
    for (const name of ["cl-local-chat", "cl-local-live"]) {
      const env = fn(name).Properties.Environment.Variables;
      expect(env.S3_PUBLIC_ENDPOINT, name).toBe("http://localhost:4566");
      expect(env.FILES_BUCKET, name).toBeDefined();
    }
  });
});
