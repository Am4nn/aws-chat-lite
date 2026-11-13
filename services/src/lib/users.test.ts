import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userActive } from "./users.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const answer = (result: object | Error) => {
  vi.stubEnv("USER_POOL_ID", "pool-1");
  return vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation((async () => {
    if (result instanceof Error) throw result;
    return result;
  }) as never);
};

describe("userActive", () => {
  it("asks the pool about the user by name", async () => {
    const send = answer({ Username: "aman", Enabled: true });
    expect(await userActive("aman")).toBe(true);
    expect((send.mock.calls[0]![0] as { input: unknown }).input).toEqual({ UserPoolId: "pool-1", Username: "aman" });
  });

  it("is false for a disabled or deleted account", async () => {
    answer({ Username: "aman", Enabled: false });
    expect(await userActive("aman")).toBe(false);
    vi.restoreAllMocks();
    answer(Object.assign(new Error("User does not exist."), { name: "UserNotFoundException" }));
    expect(await userActive("aman")).toBe(false);
  });

  it("passes on any other failure, so a Cognito outage never reads as a deleted account", async () => {
    answer(Object.assign(new Error("slow down"), { name: "TooManyRequestsException" }));
    await expect(userActive("aman")).rejects.toThrow("slow down");
  });
});
