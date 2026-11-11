import type { PreSignUpTriggerEvent } from "aws-lambda";

/**
 * `@everyone` notifies the whole room, `@agent` calls the agent and `schedule` signs scheduled messages, so nobody may
 * sign up as any of them.
 */
const RESERVED = new Set(["everyone", "agent", "schedule"]);

/**
 * Cognito PreSignUp trigger. A thrown error refuses the sign-up, and Cognito hands its message to the caller. Floci
 * sends no email, so locally every new account is also confirmed at once.
 */
export async function handler(event: PreSignUpTriggerEvent) {
  if (RESERVED.has(event.userName.toLowerCase())) throw new Error("That username is reserved.");
  if (process.env.STAGE === "local") event.response.autoConfirmUser = true;
  return event;
}
