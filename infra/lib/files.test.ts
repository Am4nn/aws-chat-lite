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
  "GET /rooms/{roomId}/files", "POST /rooms/{roomId}/files/uploads", "PUT /rooms/{roomId}/files",
  "GET /rooms/{roomId}/files/download", "DELETE /rooms/{roomId}/files",
];

const fn = (name: string) => {
  const fns = Object.values(template().findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }));
  expect(fns).toHaveLength(1);
  return fns[0] as any;
};

/** The S3 statements in the policies attached to the function's execution role. */
const s3Statements = (name: string) => {
  const role = fn(name).Properties.Role["Fn::GetAtt"][0];
  return Object.values(template().findResources("AWS::IAM::Policy"))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
    .filter((s: any) => JSON.stringify(s.Resource).includes("Files"));
};
/** Each resource's object pattern, e.g. "/staging/*". */
const objectPatterns = (name: string) => s3Statements(name)
  .flatMap((s: any) => [s.Resource].flat())
  .map((r: any) => r["Fn::Join"][1].at(-1));

describe("files API", () => {
  it("has the five routes, all behind the JWT authorizer", () => {
    const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    for (const key of ROUTES) {
      const route = routes.find((p) => p.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route.AuthorizationType, key).toBe("JWT");
    }
  });

  it("the files Lambda reads and writes only staged uploads and room files, and signs for the browser's view of S3", () => {
    expect(objectPatterns("cl-local-files").sort()).toEqual(["/staging/*", "/workspaces/*"]);
    expect(s3Statements("cl-local-files").flatMap((s: any) => [s.Action].flat()).sort())
      .toEqual(["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]);
    const env = fn("cl-local-files").Properties.Environment.Variables;
    expect(env.FILES_BUCKET).toBeDefined();
    expect(env.S3_PUBLIC_ENDPOINT).toBe("http://localhost:4566");
    expect(env.WS_CALLBACK_URL).toBeDefined();
  });

  it("the run Lambda reaches room files but never staged uploads", () => {
    expect(objectPatterns("cl-local-run")).toEqual(["/workspaces/*"]);
    expect(s3Statements("cl-local-run").flatMap((s: any) => [s.Action].flat()).sort())
      .toEqual(["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]);
    expect(fn("cl-local-run").Properties.Environment.Variables.FILES_BUCKET).toBeDefined();
  });

  it("uploads nobody committed expire after a day", () => {
    const [bucket] = Object.values(template().findResources("AWS::S3::Bucket", { Properties: { BucketName: "cl-local-files" } })) as any[];
    expect(bucket.Properties.LifecycleConfiguration.Rules).toEqual([
      expect.objectContaining({ Prefix: "staging/", ExpirationInDays: 1, Status: "Enabled" }),
    ]);
  });
});
