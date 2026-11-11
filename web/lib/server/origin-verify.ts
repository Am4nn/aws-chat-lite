/**
 * The web Lambda's Function URL is public, so CloudFront adds this secret header to every request it forwards. A
 * request without it came straight to the Function URL, around CloudFront's HTTPS and security headers.
 */
export const ORIGIN_HEADER = "x-origin-verify";

/** True when the header carries the secret, or when no secret is set (`next dev`, where there is no CloudFront). */
export function originVerified(header: string | null, secret: string | undefined): boolean {
  if (!secret) return true;
  if (!header || header.length !== secret.length) return false;
  // Constant time, so response timings don't reveal how much of a guess was right.
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
