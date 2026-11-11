import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

const ROUTES = [
  "GET /rooms/{roomId}/files", "POST /rooms/{roomId}/files/uploads", "PUT /rooms/{roomId}/files",
  "GET /rooms/{roomId}/files/download", "DELETE /rooms/{roomId}/files",
];

/** The S3 statements in the policies attached to the function's execution role. */
const s3Statements = (name: string) => statementsOf(fnNamed(name)).filter((s: any) => JSON.stringify(s.Resource).includes("Files"));
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
    const env = fnNamed("cl-local-files").props.Environment.Variables;
    expect(env.FILES_BUCKET).toBeDefined();
    expect(env.S3_PUBLIC_ENDPOINT).toBe("http://localhost:4566");
    expect(env.WS_CALLBACK_URL).toBeDefined();
  });

  it("the run Lambda reaches room files but never staged uploads", () => {
    const workspaces = s3Statements("cl-local-run").filter((s: any) => JSON.stringify(s.Resource).includes("/workspaces/*"));
    expect(workspaces.flatMap((s: any) => [s.Action].flat()).sort()).toEqual(["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]);
    expect(objectPatterns("cl-local-run")).not.toContain("/staging/*");
    expect(fnNamed("cl-local-run").props.Environment.Variables.FILES_BUCKET).toBeDefined();
  });

  it("uploads nobody committed expire after a day", () => {
    const [bucket] = Object.values(template().findResources("AWS::S3::Bucket", { Properties: { BucketName: "cl-local-files" } })) as any[];
    expect(bucket.Properties.LifecycleConfiguration.Rules).toContainEqual(
      expect.objectContaining({ Prefix: "staging/", ExpirationInDays: 1, Status: "Enabled" }),
    );
  });
});
