import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect } from "vitest";
import { loadConfig, type Stage } from "./config.js";
import { CoreStack, type CoreStackProps } from "./core-stack.js";
import { SpikeStack } from "./spike-stack.js";
import type { WebBuild } from "./web.js";

/**
 * An app that bundles no Lambda: no stack is listed in `aws:cdk:bundling-stacks`, so each function gets a placeholder
 * asset instead of an esbuild run. The tests read the template, never the code.
 */
const app = () => new App({ context: { "aws:cdk:bundling-stacks": [] } });

/** Stand-ins for the values a real aws deploy reads from infra/cdk.context.json. */
export const TEST_CONTEXT = {
  alertEmail: "ops@example.com",
  certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/test",
};

/** A stage's config, as a deploy from a shell with `env` set would load it. */
const configFor = (stage: Stage, env: NodeJS.ProcessEnv = {}) =>
  loadConfig(stage, { ...(stage === "local" && { AWS_ENDPOINT_URL: "http://localhost:4566" }), ...env }, TEST_CONTEXT);

/** A stand-in for the OpenNext build: a server entry point plus a hashed bundle, the public files and a public directory. */
function fakeWebBuild(): WebBuild {
  const root = mkdtempSync(join(tmpdir(), "cl-web-build-"));
  for (const file of ["server/index.mjs", "assets/_next/static/app.js", "assets/sw.js", "assets/pcm-worklet.js", "assets/icons/a.png"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return { serverDir: join(root, "server"), assetsDir: join(root, "assets") };
}

let webBuild: WebBuild | undefined;

/** A fresh core stack, for a test that changes it (or its props) instead of only reading the shared template. */
export function buildStack(stage: Stage, props: Partial<CoreStackProps> = {}): CoreStack {
  const config = props.config ?? configFor(stage);
  return new CoreStack(app(), `cl-${stage}-core`, {
    config, env: { account: "000000000000", region: config.region }, webBuild: (webBuild ??= fakeWebBuild()), ...props,
  });
}

const cache = new Map<string, Template>();

/** The core stack's template for a stage (and deploy env), synthesized once per test file. */
export function template(stage: Stage = "local", env: NodeJS.ProcessEnv = {}): Template {
  const key = `${stage} ${JSON.stringify(env)}`;
  let t = cache.get(key);
  if (!t) {
    t = Template.fromStack(buildStack(stage, { config: configFor(stage, env) }));
    cache.set(key, t);
  }
  return t;
}

let spike: Template | undefined;

export function spikeTemplate(): Template {
  const config = configFor("local");
  return (spike ??= Template.fromStack(new SpikeStack(app(), "cl-local-spike", { config, env: { account: "000000000000", region: config.region } })));
}

/** The one Lambda function with this name, with its logical id. */
export function fnNamed(name: string, stage: Stage = "local", env: NodeJS.ProcessEnv = {}) {
  const fns = Object.entries(template(stage, env).findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }));
  expect(fns).toHaveLength(1);
  const [logicalId, fn] = fns[0]! as [string, any];
  return { logicalId, props: fn.Properties };
}

/** Every statement in the policies attached to the function's execution role. */
export function statementsOf(fn: { props: any }, stage: Stage = "local"): any[] {
  const role = fn.props.Role["Fn::GetAtt"][0];
  return Object.values(template(stage).findResources("AWS::IAM::Policy"))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

/** The route keys whose integration targets the function with this logical id; every one must use the JWT authorizer. */
export function jwtRoutesOf(logicalId: string): string[] {
  const integrations = template().findResources("AWS::ApiGatewayV2::Integration");
  return Object.values(template().findResources("AWS::ApiGatewayV2::Route"))
    .map((r: any) => r.Properties)
    .filter((p) => JSON.stringify(integrations[p.Target["Fn::Join"][1][1].Ref]).includes(logicalId))
    .map((p) => {
      expect(p.AuthorizationType, p.RouteKey).toBe("JWT");
      return p.RouteKey;
    });
}
