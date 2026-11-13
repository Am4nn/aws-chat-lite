import { describe, it, expect } from "vitest";
import { Match } from "aws-cdk-lib/assertions";
import { fnNamed, statementsOf, template } from "./test-templates.js";

describe("auth", () => {
  it("local: user pool with a PreSignUp auto-confirm trigger", () => {
    template("local").hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "cl-local-users",
      LambdaConfig: Match.objectLike({ PreSignUp: Match.anyValue() }),
    });
  });

  it("the PreSignUp trigger may read only the agent-name counts, so it can refuse an agent's name", () => {
    const fn = fnNamed("cl-local-presignup");
    expect(fn.props.Environment.Variables.TABLE_NAME).toEqual({ Ref: expect.stringMatching(/^Main/) });
    expect(statementsOf(fn).filter((s: any) => JSON.stringify(s.Action).includes("dynamodb:"))).toEqual([{
      Action: "dynamodb:GetItem", Effect: "Allow", Resource: { "Fn::GetAtt": [expect.stringMatching(/^Main/), "Arn"] },
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AGENTNAME#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }]);
  });

  it("aws: email required, and the PreSignUp trigger (which refuses names there but confirms nobody)", () => {
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
