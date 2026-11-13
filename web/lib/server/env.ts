import "server-only";

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
    /** Who turns speech into text in the composer: the browser on AWS, whose free plan blocks Transcribe; else Transcribe. */
    dictation: e.DICTATION === "browser" ? "browser" as const : "transcribe" as const,
    /**
     * The site's public origins, allowed to write through /bff/*. They must be set whenever the app sits behind a proxy:
     * CloudFront doesn't forward the browser's Host, so the request's own host is the Function URL's and can't match.
     */
    siteOrigins: (e.SITE_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    /** Set locally, where the emulator serves /mcp on an address of its own; on AWS the site's origin serves it. */
    mcpBaseUrl: e.MCP_BASE_URL?.replace(/\/$/, "") || undefined,
    /** The secret CloudFront sends in x-origin-verify; unset in next dev, which turns the check off. */
    originSecret: e.ORIGIN_VERIFY_SECRET || undefined,
  };
}
