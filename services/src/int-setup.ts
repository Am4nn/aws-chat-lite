import { readFileSync } from "node:fs";

// Each local deploy makes a new user pool, whose id only the deploy's outputs hold. Agents' names are checked against
// its accounts, and the Cognito tests make accounts in it.
const outputs = JSON.parse(readFileSync(new URL("../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.USER_POOL_ID = outputs["cl-local-core"].UserPoolId;
