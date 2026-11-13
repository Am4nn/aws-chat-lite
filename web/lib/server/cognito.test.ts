import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./cognito";

const refused = (message: string) => Object.assign(new Error(`PreSignUp failed with error ${message}`), { name: "UserLambdaValidationException" });

describe("authErrorMessage", () => {
  it("passes on the sign-up trigger's own refusal", () => {
    expect(authErrorMessage(refused("That username is reserved."))).toBe("That username is reserved.");
    expect(authErrorMessage(refused("That username is taken."))).toBe("That username is taken.");
  });

  it("never passes on anything else the trigger failed with", () => {
    expect(authErrorMessage(refused("Task timed out after 5.00 seconds"))).toBe("Something went wrong.");
  });

  it("reads Cognito's own errors by name", () => {
    expect(authErrorMessage(Object.assign(new Error("x"), { name: "UsernameExistsException" }))).toBe("That username is taken.");
  });
});
