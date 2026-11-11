import type { PreSignUpTriggerEvent } from "aws-lambda";

/** `@agent` and `@everyone` already mean something in a message, so no one may sign up under those names. */
const RESERVED = new Set(["agent", "everyone"]);

/**
 * Cognito PreSignUp trigger. A thrown error refuses the sign-up, and Cognito hands its message to the client.
 * Floci sends no email, so where AUTO_CONFIRM is set (locally) every new account is confirmed at once.
 */
export async function handler(event: PreSignUpTriggerEvent) {
  if (RESERVED.has(event.userName.toLowerCase())) throw new Error("That username is reserved.");
  if (process.env.AUTO_CONFIRM === "true") event.response.autoConfirmUser = true;
  return event;
}
