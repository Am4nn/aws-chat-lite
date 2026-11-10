/**
 * Adds a user to a Cognito group, e.g. `npm run grant -- aman creators` (who may create rooms).
 * The user signs out and in again to get a token with the new group. `--stage=aws` uses your `ig` profile.
 */
import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { useAwsEnv, useLocalEnv } from "./env.js";
import { readOutputs } from "./deploy-local.js";
import { grantArgs } from "./grant-args.js";

async function main() {
  const { username, group, stage } = grantArgs(process.argv.slice(2));
  if (stage === "aws") useAwsEnv(); else useLocalEnv();
  const out = stage === "aws" ? readOutputs("cl-aws-core", "outputs-aws.json") : readOutputs("cl-local-core");
  if (!out.UserPoolId) throw new Error(`No UserPoolId in the ${stage} outputs: deploy first.`);
  await new CognitoIdentityProviderClient({}).send(new AdminAddUserToGroupCommand({
    UserPoolId: out.UserPoolId, Username: username, GroupName: group,
  }));
  console.log(`✅ ${username} is now in "${group}" (${stage}). Sign out and in again to refresh the token.`);
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
