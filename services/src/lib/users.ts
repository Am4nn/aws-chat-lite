import { AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { requiredEnv } from "./env.js";

let client: CognitoIdentityProviderClient | undefined;

/** Whether a Cognito account still exists and is enabled. */
export async function userActive(username: string): Promise<boolean> {
  try {
    const user = await (client ??= new CognitoIdentityProviderClient({})).send(
      new AdminGetUserCommand({ UserPoolId: requiredEnv("USER_POOL_ID"), Username: username }),
    );
    return user.Enabled !== false;
  } catch (e) {
    if ((e as Error).name === "UserNotFoundException") return false;
    throw e;
  }
}
