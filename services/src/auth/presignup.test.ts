import { describe, it, expect, afterEach } from "vitest";
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { handler } from "./presignup.js";

const signUp = (userName: string) => ({ userName, response: {} }) as PreSignUpTriggerEvent;

afterEach(() => { delete process.env.STAGE; });

describe("PreSignUp", () => {
  it("refuses the names mentions give a meaning to, in any case", async () => {
    await expect(handler(signUp("everyone"))).rejects.toThrow("That username is reserved.");
    await expect(handler(signUp("Agent"))).rejects.toThrow("That username is reserved.");
  });

  it("confirms at once locally, where no email is sent", async () => {
    process.env.STAGE = "local";
    expect((await handler(signUp("ann"))).response.autoConfirmUser).toBe(true);
  });

  it("leaves confirmation to the emailed code on AWS", async () => {
    process.env.STAGE = "aws";
    expect((await handler(signUp("ann"))).response.autoConfirmUser).toBeUndefined();
  });
});
