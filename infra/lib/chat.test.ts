import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

const ROUTES = [
  "POST /live/ticket", "GET /rooms/{roomId}/chats/{chatId}/messages", "POST /rooms/{roomId}/attachments", "GET /rooms/{roomId}/search",
];

const chatFunction = () => fnNamed("cl-local-chat");
const statements = (name: string) => statementsOf(fnNamed(name));
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
    const url = chatFunction().props.Environment.Variables.WS_URL;
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
    expect(s3Actions("cl-local-chat").sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(s3Actions("cl-local-live")).toEqual(["s3:GetObject"]);
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
    template("aws").hasResourceProperties("AWS::S3::Bucket", { BucketName: "cl-aws-files-000000000000" });
  });

  // A room keeps only the latest version of each file; with versioning on, every overwrite and delete would keep
  // (and bill) the old bytes.
  it("the files bucket has versioning off on both stages", () => {
    for (const [stage, name] of [["local", "cl-local-files"], ["aws", "cl-aws-files-000000000000"]] as const) {
      const [bucket] = Object.values(template(stage).findResources("AWS::S3::Bucket", { Properties: { BucketName: name } })) as any[];
      expect(bucket, stage).toBeDefined();
      expect(bucket.Properties.VersioningConfiguration, stage).toBeUndefined();
    }
  });

  it("both sign URLs for the browser's view of S3 (Floci's host locally)", () => {
    for (const name of ["cl-local-chat", "cl-local-live"]) {
      const env = fnNamed(name).props.Environment.Variables;
      expect(env.S3_PUBLIC_ENDPOINT, name).toBe("http://localhost:4566");
      expect(env.FILES_BUCKET, name).toBeDefined();
    }
  });
});
