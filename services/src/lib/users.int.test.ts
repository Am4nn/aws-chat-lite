import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it } from "vitest";
import { userActive } from "./users.js";

// Runs against Cognito on Floci: npm run deploy:local, then this file.
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.USER_POOL_ID = outputs["cl-local-core"].UserPoolId;

describe("userActive on Floci", () => {
  it("is true for an account, then false once it is disabled, and false once it is deleted", async () => {
    const cognito = new CognitoIdentityProviderClient({});
    const pool = { UserPoolId: process.env.USER_POOL_ID, Username: `test-${randomUUID().slice(0, 8)}` };
    await cognito.send(new AdminCreateUserCommand({ ...pool, MessageAction: "SUPPRESS" }));
    expect(await userActive(pool.Username)).toBe(true);
    await cognito.send(new AdminDisableUserCommand(pool));
    expect(await userActive(pool.Username)).toBe(false);
    await cognito.send(new AdminDeleteUserCommand(pool));
    expect(await userActive(pool.Username)).toBe(false);
  });
});
