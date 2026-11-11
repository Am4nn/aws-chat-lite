import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { template } from "./test-templates.js";

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
