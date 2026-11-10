import type { PreSignUpTriggerEvent } from "aws-lambda";

/** Cognito PreSignUp trigger: skip email/SMS verification (learning app). */
export async function handler(event: PreSignUpTriggerEvent) {
  event.response.autoConfirmUser = true;
  return event;
}
