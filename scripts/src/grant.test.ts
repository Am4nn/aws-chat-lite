import { describe, it, expect } from "vitest";
import { grantArgs } from "./grant-args.js";

describe("grantArgs", () => {
  it("parses username + group, local by default", () => {
    expect(grantArgs(["aman", "creators"])).toEqual({ username: "aman", group: "creators", stage: "local" });
  });
  it("takes --stage=aws", () => {
    expect(grantArgs(["aman", "creators", "--stage=aws"]).stage).toBe("aws");
  });
  it("explains usage when arguments are missing", () => {
    expect(() => grantArgs([])).toThrow(/usage: npm run grant -- <username> <group>/);
    expect(() => grantArgs(["aman"])).toThrow(/usage/);
  });
});
