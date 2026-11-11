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
  const presignup = (stage: "local" | "aws") =>
    (Object.values(template(stage).findResources("AWS::Lambda::Function", { Properties: { FunctionName: `cl-${stage}-presignup` } }))[0] as any)
      ?.Properties;

  it("every stage has the PreSignUp trigger (it refuses reserved usernames); only local auto-confirms", () => {
    for (const stage of ["local", "aws"] as const) {
      template(stage).hasResourceProperties("AWS::Cognito::UserPool", {
        UserPoolName: `cl-${stage}-users`,
        LambdaConfig: Match.objectLike({ PreSignUp: Match.anyValue() }),
      });
    }
    expect(presignup("local").Environment.Variables.AUTO_CONFIRM).toBe("true");
    expect(presignup("aws").Environment.Variables.AUTO_CONFIRM).toBeUndefined();
  });

  it("aws: email required", () => {
    const pools = template("aws").findResources("AWS::Cognito::UserPool");
    const props = (Object.values(pools)[0] as any).Properties;
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
