import type { PreSignUpTriggerEvent } from "aws-lambda";

/** Cognito PreSignUp trigger, local stage only: Floci sends no email, so every new account is confirmed at once. */
export async function handler(event: PreSignUpTriggerEvent) {
  event.response.autoConfirmUser = true;
  return event;
}
