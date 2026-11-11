import { createHash } from "node:crypto";
import { ValidationError } from "../lib/errors.js";
import type { PushSubscriptionInput } from "./types.js";

// The push services of Chrome (FCM), Firefox (Mozilla), Safari (Apple) and Edge (WNS). The worker posts to
// whatever endpoint a user saved, so anything else, such as an internal address, is refused here (an SSRF guard).
const HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
const MAX_ENDPOINT = 1024;

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const decoded = (value: unknown) => (typeof value === "string" && BASE64URL.test(value) ? Buffer.from(value, "base64url") : undefined);

function pushServiceUrl(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT || !URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password
    && (HOSTS.has(url.hostname) || HOST_SUFFIXES.some((s) => url.hostname.endsWith(s)));
}

/** A browser subscription with only the fields the sender uses, or a refusal. */
export function subscriptionOf(raw: unknown): PushSubscriptionInput {
  const { endpoint, keys } = (raw ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  // An uncompressed P-256 point (0x04, then x and y) and the 16-byte auth secret that RFC 8291 encryption needs.
  const p256dh = decoded(keys?.p256dh);
  const auth = decoded(keys?.auth);
  if (!pushServiceUrl(endpoint) || p256dh?.length !== 65 || p256dh[0] !== 4 || auth?.length !== 16) {
    throw new ValidationError("That isn't a browser push subscription.");
  }
  return { endpoint, keys: { p256dh: String(keys!.p256dh), auth: String(keys!.auth) } };
}

/** One id per device: a browser subscription's endpoint is unique to it. */
export function subscriptionId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}
