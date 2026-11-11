import { bff } from "./bff";

/**
 * Web push for this browser: one subscription per device, saved on the server under the same id the server derives
 * from its endpoint. The toggle is per device, so turning it off here leaves the user's other devices alone.
 */
export type PushSupport = "unsupported" | "install" | "blocked" | "ready";
/** What the toggle shows; "hidden" when the server has no push keys. */
export type PushState = "hidden" | Exclude<PushSupport, "ready"> | "on" | "off";

type PushEnv = {
  navigator: { userAgent: string; maxTouchPoints: number; standalone?: boolean };
  window: object & { matchMedia(query: string): { matches: boolean } };
  Notification?: { permission: NotificationPermission };
};

const KEY_PATH = "/bff/api/push/key";
const SAVE_PATH = "/bff/api/me/push";

const browserEnv = (): PushEnv => ({ navigator, window, Notification: globalThis.Notification });

/** iPhone and iPad Safari offer push only to a site opened from the Home Screen. */
export function pushSupport(env: PushEnv = browserEnv()): PushSupport {
  const { userAgent, maxTouchPoints, standalone } = env.navigator;
  // iPadOS Safari reports itself as a Mac; the touch screen gives it away.
  const apple = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  if (apple && !standalone && !env.window.matchMedia("(display-mode: standalone)").matches) return "install";
  if (!("PushManager" in env.window) || !env.Notification) return "unsupported";
  return env.Notification.permission === "denied" ? "blocked" : "ready";
}

export async function pushState(): Promise<PushState> {
  const { publicKey } = await bff<{ publicKey: string | null }>(KEY_PATH);
  if (!publicKey) return "hidden";
  const support = pushSupport();
  if (support !== "ready") return support;
  return Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
}

/**
 * Call it straight from the click, before anything else is awaited: Safari only shows the permission prompt within
 * the click that asked. True when this device now gets notifications.
 */
export async function enablePush(): Promise<boolean> {
  const [permission, { publicKey }] = await Promise.all([
    Notification.requestPermission(),
    bff<{ publicKey: string | null }>(KEY_PATH),
    navigator.serviceWorker.register("/sw.js"),
  ]);
  if (permission !== "granted" || !publicKey) return false;
  // Subscribing needs an active worker, which a first registration may not have yet.
  const { pushManager } = await navigator.serviceWorker.ready;
  const key = fromBase64Url(publicKey);
  let subscription = await pushManager.getSubscription();
  // A subscription made with an old key can't be sent to with the new one.
  if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await save(subscription);
  return true;
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const id = await subscriptionId(subscription.endpoint);
  await subscription.unsubscribe();
  await bff(`${SAVE_PATH}/${id}`, { method: "DELETE" });
}

/** Saves this device again, which brings back one the server dropped (a failed send, or the per-user cap). */
export async function syncPush(): Promise<void> {
  if (globalThis.Notification?.permission !== "granted") return;
  const subscription = await currentSubscription();
  if (subscription) await save(subscription);
}

export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// navigator.serviceWorker is missing outside a secure context, such as the dev server opened by a LAN address.
const currentSubscription = async () => (await navigator.serviceWorker?.getRegistration())?.pushManager.getSubscription() ?? null;

const save = (subscription: PushSubscription) => bff(SAVE_PATH, { method: "PUT", body: subscription.toJSON() });

const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const sameBytes = (buffer: ArrayBuffer | null, bytes: Uint8Array) => buffer !== null && new Uint8Array(buffer).join() === bytes.join();
