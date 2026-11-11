import { describe, it, expect, afterEach } from "vitest";
import { handler } from "./presignup.js";

const signUp = (userName: string) => ({ userName, response: {} }) as any;

afterEach(() => { delete process.env.AUTO_CONFIRM; });

describe("pre-sign-up trigger", () => {
  it.each(["agent", "Agent", "everyone"])("refuses the reserved username %s", async (name) => {
    await expect(handler(signUp(name))).rejects.toThrow("That username is reserved.");
  });

  it("confirms the account at once only where AUTO_CONFIRM is set", async () => {
    expect((await handler(signUp("aman"))).response.autoConfirmUser).toBeUndefined();
    process.env.AUTO_CONFIRM = "true";
    expect((await handler(signUp("aman"))).response.autoConfirmUser).toBe(true);
  });
});
