import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "./bff";
import { disablePush, enablePush, pushState, pushSupport, subscriptionId, syncPush } from "./push";

vi.mock("./bff", () => ({ bff: vi.fn() }));

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
// The server's key is base64url; these are its bytes.
const KEY = "BAEC";
const KEY_BYTES = [4, 1, 2];

function env({ userAgent = CHROME, standalone = false, pushManager = true, permission = "default" as NotificationPermission } = {}) {
  return {
    navigator: { userAgent, maxTouchPoints: 0, standalone },
    window: { matchMedia: () => ({ matches: standalone }), ...(pushManager ? { PushManager: class {} } : {}) },
    Notification: { permission },
  };
}

describe("pushSupport", () => {
  it("an iPhone outside the Home Screen app is told to install first", () => {
    expect(pushSupport(env({ userAgent: IPHONE, pushManager: false }))).toBe("install");
    expect(pushSupport(env({ userAgent: IPHONE, standalone: true }))).toBe("ready");
  });
  it("no PushManager → unsupported; a denied permission → blocked; otherwise ready", () => {
    expect(pushSupport(env({ pushManager: false }))).toBe("unsupported");
    expect(pushSupport(env({ permission: "denied" }))).toBe("blocked");
    expect(pushSupport(env())).toBe("ready");
  });
});

it("subscriptionId is the server's id for the same endpoint", async () => {
  expect(await subscriptionId(ENDPOINT)).toBe("4e9bdab8bbe7189c00aebb0922fc49fe");
});

/** A browser with push: one registration whose push manager holds at most one subscription. */
function browser({ permission = "granted" as NotificationPermission, subscribed = false, subscribedKey = KEY_BYTES } = {}) {
  const subscription = (key: number[]) => ({
    endpoint: ENDPOINT,
    options: { applicationServerKey: new Uint8Array(key).buffer },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => { current = null; return true; }),
  });
  let current: ReturnType<typeof subscription> | null = subscribed ? subscription(subscribedKey) : null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => (current = subscription([...applicationServerKey]))),
  };
  const registration = { pushManager };
  const serviceWorker = { register: vi.fn(async () => registration), ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration) };
  const Notification = { permission, requestPermission: vi.fn(async () => permission) };
  vi.stubGlobal("navigator", { userAgent: CHROME, maxTouchPoints: 0, serviceWorker });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), PushManager: class {} });
  vi.stubGlobal("Notification", Notification);
  return { pushManager, serviceWorker, Notification, current: () => current };
}

const calls = () => vi.mocked(bff).mock.calls;

describe("turning push on and off", () => {
  beforeEach(() => {
    vi.mocked(bff).mockReset();
    vi.mocked(bff).mockImplementation(async (path: string) => (path === "/bff/api/push/key" ? { publicKey: KEY } : {}));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("enablePush asks first, registers the worker, subscribes with the server's key and saves the subscription", async () => {
    const b = browser();
    expect(await enablePush()).toBe(true);
    expect(b.Notification.requestPermission).toHaveBeenCalled();
    expect(b.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
    expect(b.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array(KEY_BYTES) });
    expect(calls()).toContainEqual(["/bff/api/me/push", { method: "PUT", body: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } } }]);
  });

  it("enablePush replaces a subscription made with another key", async () => {
    const b = browser({ subscribed: true, subscribedKey: [4, 9, 9] });
    const old = b.current()!;
    await enablePush();
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(b.pushManager.subscribe).toHaveBeenCalled();
  });

  it("enablePush saves nothing when the permission isn't granted", async () => {
    const b = browser({ permission: "denied" });
    expect(await enablePush()).toBe(false);
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls().some(([path]) => path === "/bff/api/me/push")).toBe(false);
  });

  it("disablePush unsubscribes this browser, then forgets this device on the server", async () => {
    const b = browser({ subscribed: true });
    const sub = b.current()!;
    await disablePush();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(calls()).toEqual([["/bff/api/me/push/4e9bdab8bbe7189c00aebb0922fc49fe", { method: "DELETE" }]]);
  });

  it("disablePush does nothing where nothing is subscribed", async () => {
    browser();
    await disablePush();
    expect(calls()).toEqual([]);
  });

  it("syncPush saves an existing subscription again, and only with the permission granted", async () => {
    browser({ subscribed: true });
    await syncPush();
    expect(calls()).toEqual([["/bff/api/me/push", { method: "PUT", body: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } } }]]);

    vi.mocked(bff).mockClear();
    browser({ subscribed: true, permission: "default" });
    await syncPush();
    expect(calls()).toEqual([]);
  });

  it("pushState: hidden without a server key, else the browser's support, else on or off", async () => {
    browser({ subscribed: true });
    expect(await pushState()).toBe("on");
    browser();
    expect(await pushState()).toBe("off");
    browser({ permission: "denied" });
    expect(await pushState()).toBe("blocked");
    vi.mocked(bff).mockResolvedValue({ publicKey: null });
    expect(await pushState()).toBe("hidden");
  });
});
