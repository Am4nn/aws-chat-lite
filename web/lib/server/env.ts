/** Server-only settings, read at request time so they never end up in the browser bundle. */
export function serverEnv() {
  const e = process.env;
  return {
    apiUrl: (e.API_URL ?? "").replace(/\/$/, ""),
    userPoolClientId: e.USER_POOL_CLIENT_ID ?? "",
    cognitoRegion: e.COGNITO_REGION || "us-east-1",
    /** Set locally to reach the emulated Cognito; unset on AWS, where the regional endpoint is used. */
    cognitoEndpoint: e.COGNITO_ENDPOINT || undefined,
    /** On AWS, sign-up needs an email and a confirmation code; locally accounts are confirmed at once. */
    emailSignup: e.SIGNUP_EMAIL === "required",
    secureCookies: e.SECURE_COOKIES === "true",
    /** Extra browser origins allowed to write through /bff/* (for example a custom domain). */
    siteOrigins: (e.SITE_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
