import { describe, it, expect } from "vitest";
import { fnNamed, statementsOf, template } from "./test-templates.js";

const ROUTES = ["POST /mcp", "GET /mcp", "DELETE /mcp"];
// Anyone who may read a function's configuration sees its environment, so no credential belongs there. CloudFront's
// origin nonce is the exception: it only tells CloudFront's requests apart and opens nothing.
const SECRET_NAME = /KEY|TOKEN(?!_KEY_SECRET)|(?<!^ORIGIN_VERIFY_)SECRET$/;

describe("chat-lite's MCP server", () => {
  it("one Lambda serves /mcp with no authorizer: it checks its own bearer tokens", () => {
    const { logicalId } = fnNamed("cl-local-mcp");
    const integrations = template().findResources("AWS::ApiGatewayV2::Integration");
    const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r: any) => r.Properties);
    for (const key of ROUTES) {
      const route = routes.find((p) => p.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route.AuthorizationType, key).toBe("NONE");
      const integration = String(route.Target["Fn::Join"][1][1].Ref);
      expect(JSON.stringify(integrations[integration]), key).toContain(logicalId);
    }
  });

  it("has 30 s and the table, knows its public base and the site, may tell rooms and start runs, and signs file links", () => {
    const { props } = fnNamed("cl-local-mcp");
    expect(props.Timeout).toBe(30);
    const env = props.Environment.Variables;
    expect(env).toMatchObject({
      SITE_URL: "http://localhost:3000", TABLE_NAME: { Ref: expect.any(String) }, RUN_FN_NAME: { Ref: fnNamed("cl-local-run").logicalId },
      S3_PUBLIC_ENDPOINT: "http://localhost:4566",
    });
    expect(JSON.stringify(env.MCP_BASE_URL)).toMatch(/"http:\/\/".*"\.execute-api\.localhost\.floci\.io:4566"/);
    expect(env.WS_CALLBACK_URL).toBeDefined();
    expect(env.FILES_BUCKET).toBeDefined();
    expect(fnNamed("cl-aws-mcp", "aws").props.Environment.Variables).toMatchObject({ MCP_BASE_URL: "https://chat.amanarya.com" });
  });

  it("reads room files only, and only to sign download links", () => {
    const s3 = statementsOf(fnNamed("cl-local-mcp")).filter((s: any) => JSON.stringify(s.Resource).includes("Files"));
    expect(s3.flatMap((s: any) => [s.Action].flat())).toEqual(["s3:GetObject"]);
    for (const s of s3) expect(JSON.stringify(s.Resource)).toMatch(/\/rooms\/\*"/);
  });

  it("neither public Lambda carries anything named like a secret in its environment", () => {
    for (const stage of ["local", "aws"] as const) {
      for (const name of ["oauth", "mcp"]) {
        const names = Object.keys(fnNamed(`cl-${stage}-${name}`, stage).props.Environment.Variables);
        expect(names.filter((n) => SECRET_NAME.test(n)), `${stage} ${name}`).toEqual([]);
      }
    }
  });
});
