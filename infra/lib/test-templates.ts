import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect } from "vitest";
import { loadConfig } from "./config.js";
import { CoreStack } from "./core-stack.js";
import { SpikeStack } from "./spike-stack.js";

type Stage = "local" | "aws";

/**
 * An app that bundles no Lambda: no stack is listed in `aws:cdk:bundling-stacks`, so each function gets a placeholder
 * asset instead of an esbuild run. The tests read the template, never the code.
 */
const app = () => new App({ context: { "aws:cdk:bundling-stacks": [] } });

/** A stage's config, as a deploy from a shell with `env` set would load it. */
const configFor = (stage: Stage, env: NodeJS.ProcessEnv = {}) =>
  loadConfig(stage, { ...(stage === "local" && { AWS_ENDPOINT_URL: "http://localhost:4566" }), ...env });

const cache = new Map<string, Template>();

/** The core stack's template for a stage (and deploy env), synthesized once per test file. */
export function template(stage: Stage = "local", env: NodeJS.ProcessEnv = {}): Template {
  const key = `${stage} ${JSON.stringify(env)}`;
  let t = cache.get(key);
  if (!t) {
    const config = configFor(stage, env);
    t = Template.fromStack(new CoreStack(app(), `cl-${stage}-core`, { config, env: { account: "000000000000", region: config.region } }));
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
