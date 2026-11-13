import { AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { requiredEnv } from "./env.js";

let client: CognitoIdentityProviderClient | undefined;

/** The Cognito account by this exact name, or null when there is none. */
async function findUser(username: string) {
  try {
    return await (client ??= new CognitoIdentityProviderClient({})).send(
      new AdminGetUserCommand({ UserPoolId: requiredEnv("USER_POOL_ID"), Username: username }),
    );
  } catch (e) {
    if ((e as Error).name === "UserNotFoundException") return null;
    throw e;
  }
}

/** Whether a Cognito account still exists and is enabled. */
export async function userActive(username: string): Promise<boolean> {
  const user = await findUser(username);
  return !!user && user.Enabled !== false;
}

/** Whether any account, disabled or not, holds this name: Cognito won't give a held name to anyone else. */
export async function userExists(username: string): Promise<boolean> {
  return !!(await findUser(username));
}
