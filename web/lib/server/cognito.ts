import "server-only";
import {
  CognitoIdentityProviderClient, ConfirmSignUpCommand, InitiateAuthCommand, ResendConfirmationCodeCommand,
  RevokeTokenCommand, SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { serverEnv } from "./env";

/**
 * Cognito calls made by the Next.js server, never the browser: the auth route handlers put the resulting tokens in
 * httpOnly cookies. The web app client is public, so these calls need no AWS credentials; the SDK still insists on
 * having some, hence the placeholders.
 */
let client: CognitoIdentityProviderClient | undefined;
function cognito() {
  const env = serverEnv();
  return (client ??= new CognitoIdentityProviderClient({
    region: env.cognitoRegion,
    endpoint: env.cognitoEndpoint,
    credentials: { accessKeyId: "unused", secretAccessKey: "unused" },
  }));
}
const clientId = () => serverEnv().userPoolClientId;

type Tokens = { idToken: string; refreshToken?: string; expiresIn: number };

export async function signIn(username: string, password: string): Promise<Tokens> {
  const r = await cognito().send(new InitiateAuthCommand({
    ClientId: clientId(), AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  const a = r.AuthenticationResult;
  if (!a?.IdToken) throw new Error("Sign-in did not return a token.");
  return { idToken: a.IdToken, refreshToken: a.RefreshToken, expiresIn: a.ExpiresIn ?? 3600 };
}

export async function refresh(refreshToken: string): Promise<Tokens> {
  const r = await cognito().send(new InitiateAuthCommand({
    ClientId: clientId(), AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: refreshToken },
  }));
  const a = r.AuthenticationResult;
  if (!a?.IdToken) throw new Error("Refresh did not return a token.");
  return { idToken: a.IdToken, expiresIn: a.ExpiresIn ?? 3600 };
}

/** Revoking on sign-out means a copied refresh token stops working too. Failure is ignored: the cookies go anyway. */
export async function revoke(refreshToken: string): Promise<void> {
  await cognito().send(new RevokeTokenCommand({ ClientId: clientId(), Token: refreshToken })).catch(() => {});
}

/** `confirmed` is false when Cognito emailed a code (to the masked `sentTo` address) that must be entered first. */
export async function signUp(username: string, password: string, email?: string): Promise<{ confirmed: boolean; sentTo?: string }> {
  const r = await cognito().send(new SignUpCommand({
    ClientId: clientId(), Username: username, Password: password,
    UserAttributes: email ? [{ Name: "email", Value: email }] : undefined,
  }));
  return { confirmed: r.UserConfirmed !== false, sentTo: r.CodeDeliveryDetails?.Destination };
}

export async function confirmSignUp(username: string, code: string): Promise<void> {
  await cognito().send(new ConfirmSignUpCommand({ ClientId: clientId(), Username: username, ConfirmationCode: code.trim() }));
}

export async function resendCode(username: string): Promise<string | undefined> {
  const r = await cognito().send(new ResendConfirmationCodeCommand({ ClientId: clientId(), Username: username }));
  return r.CodeDeliveryDetails?.Destination;
}

const MESSAGES: Record<string, string> = {
  UsernameExistsException: "That username is taken.",
  NotAuthorizedException: "Wrong username or password.",
  UserNotFoundException: "No account with that username.",
  InvalidPasswordException: "Password must be at least 8 characters.",
  CodeMismatchException: "That code isn't right. Check the email and try again.",
  ExpiredCodeException: "That code has expired. Send a new one.",
  LimitExceededException: "Too many tries. Wait a few minutes.",
  TooManyRequestsException: "Too many tries. Wait a few minutes.",
  CodeDeliveryFailureException: "We couldn't send the email. Try again later.",
};

/**
 * The PreSignUp trigger's refusals. Cognito puts the trigger's message inside its own, and a crashed trigger's text is
 * there too, so only these known lines are ever shown.
 */
const SIGN_UP_REFUSALS = ["That username is reserved.", "That username is taken."];

export function authErrorMessage(e: unknown) {
  const { name = "", message = "" } = (e ?? {}) as Error;
  if (name === "UserLambdaValidationException") return SIGN_UP_REFUSALS.find((m) => message.includes(m)) ?? "Something went wrong.";
  return MESSAGES[name] ?? "Something went wrong.";
}
