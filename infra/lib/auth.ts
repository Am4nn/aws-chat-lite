import { CfnOutput } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { FLOCI_PORT } from "./config.js";
import type { CoreStack } from "./core-stack.js";

export interface Auth {
  userPool: cognito.UserPool;
  client: cognito.UserPoolClient;
  authorizer: HttpJwtAuthorizer;
}

/**
 * Cognito users, the `creators` group (who may create rooms) and the JWT authorizer for the HTTP API. A PreSignUp
 * trigger refuses reserved usernames and agents' names everywhere, and records each name it lets through. Floci sends
 * no email, so locally that trigger also confirms every account at once; on AWS sign-up needs an email address and a
 * confirmation code.
 *
 * Anyone may start a sign-up, so the trigger may only read agent-name counts and write username records, each by its
 * partition key. The Null condition stops a request without a key from passing ForAllValues trivially.
 */
export function addAuth(stack: CoreStack): Auth {
  const { prefix, isLocal } = stack.stageConfig;
  const preSignUp = stack.addFunction("presignup", "auth/presignup.ts");
  for (const [action, keys] of [["dynamodb:GetItem", "AGENTNAME#*"], ["dynamodb:PutItem", "USERNAME#*"]] as const) {
    preSignUp.addToRolePolicy(new iam.PolicyStatement({
      actions: [action],
      resources: [stack.table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [keys] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }));
  }
  const userPool = new cognito.UserPool(stack, "Users", {
    userPoolName: `${prefix}-users`,
    selfSignUpEnabled: true,
    signInAliases: { username: true },
    passwordPolicy: { minLength: 8, requireSymbols: false, requireUppercase: false, requireDigits: false },
    removalPolicy: stack.userDataRemoval,
    lambdaTriggers: { preSignUp },
    ...(!isLocal && {
      standardAttributes: { email: { required: true, mutable: true } },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    }),
  });
  const client = userPool.addClient("Web", {
    userPoolClientName: `${prefix}-web`,
    authFlows: { userPassword: true },
    generateSecret: false,
  });
  new cognito.CfnUserPoolGroup(stack, "CreatorsGroup", {
    userPoolId: userPool.userPoolId,
    groupName: "creators",
    description: "May create rooms (npm run grant -- <username> creators)",
  });
  // Floci's tokens name their issuer with a literal loopback IP, not localhost.
  const issuer = isLocal
    ? `http://127.0.0.1:${FLOCI_PORT}/${userPool.userPoolId}`
    : `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}`;
  const authorizer = new HttpJwtAuthorizer("Jwt", issuer, { jwtAudience: [client.userPoolClientId] });

  new CfnOutput(stack, "UserPoolId", { value: userPool.userPoolId });
  new CfnOutput(stack, "UserPoolClientId", { value: client.userPoolClientId });
  return { userPool, client, authorizer };
}
