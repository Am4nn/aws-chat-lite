import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { CoreStack } from "./core-stack.js";
import { loadConfig } from "./config.js";

const cache: Record<string, Template> = {};
const template = (stage: "local" | "aws") => {
  if (cache[stage]) return cache[stage];
  const env = stage === "local" ? { AWS_ENDPOINT_URL: "http://localhost:4566" } : {};
  const config = loadConfig(stage, env);
  const stack = new CoreStack(new App(), `cl-${stage}-core`, { config, env: { account: "000000000000", region: config.region } });
  return (cache[stage] = Template.fromStack(stack));
};

describe("auth", () => {
  it("local: user pool with a PreSignUp auto-confirm trigger", () => {
    template("local").hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "cl-local-users",
      LambdaConfig: Match.objectLike({ PreSignUp: Match.anyValue() }),
    });
  });

  it("aws: email required, and the PreSignUp trigger (which only reserves names there)", () => {
    const pools = template("aws").findResources("AWS::Cognito::UserPool");
    const props = (Object.values(pools)[0] as any).Properties;
    expect(props.LambdaConfig?.PreSignUp).toBeDefined();
    expect(props.Schema).toEqual(expect.arrayContaining([expect.objectContaining({ Name: "email", Required: true })]));
  });

  it("web client allows password + refresh auth", () => {
    template("local").hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]),
    });
  });

  it("has the creators group", () => {
    template("local").hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "creators" });
  });
});
