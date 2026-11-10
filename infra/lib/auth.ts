import { RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import type { CoreStack } from "./core-stack.js";

export interface Auth {
  userPool: cognito.UserPool;
  client: cognito.UserPoolClient;
  authorizer: HttpJwtAuthorizer;
}

/**
 * Cognito users, the `creators` group (who may create rooms) and the JWT authorizer for the HTTP API.
 * Floci sends no email, so locally a PreSignUp trigger confirms every account at once; on AWS sign-up needs an
 * email address and a confirmation code.
 */
export function addAuth(stack: CoreStack): Auth {
  const { prefix, isLocal } = stack.stageConfig;
  const userPool = new cognito.UserPool(stack, "Users", {
    userPoolName: `${prefix}-users`,
    selfSignUpEnabled: true,
    signInAliases: { username: true },
    passwordPolicy: { minLength: 8, requireSymbols: false, requireUppercase: false, requireDigits: false },
    removalPolicy: RemovalPolicy.DESTROY,
    ...(isLocal
      ? { lambdaTriggers: { preSignUp: stack.addFunction("presignup", "auth/presignup.ts") } }
      : {
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
  // Floci's tokens name their issuer with a literal loopback IP, http://127.0.0.1:4566/<pool>, not localhost.
  const issuer = isLocal
    ? `http://127.0.0.1:4566/${userPool.userPoolId}`
    : `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}`;
  const authorizer = new HttpJwtAuthorizer("Jwt", issuer, { jwtAudience: [client.userPoolClientId] });

  new CfnOutput(stack, "UserPoolId", { value: userPool.userPoolId });
  new CfnOutput(stack, "UserPoolClientId", { value: client.userPoolClientId });
  return { userPool, client, authorizer };
}
