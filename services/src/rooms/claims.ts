/** The app-level group that may create rooms (granted with `npm run grant -- <username> creators`). */
export const CREATORS = "creators";

/**
 * True when the token's `cognito:groups` holds "creators". API Gateway's JWT authorizer passes array
 * claims as a bracketed, space-separated string ("[creators admins]"); a decoded token has a real array.
 */
export function isCreator(claims: Record<string, unknown>): boolean {
  const raw = claims["cognito:groups"];
  const groups = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string" ? raw.replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean) : [];
  return groups.includes(CREATORS);
}
