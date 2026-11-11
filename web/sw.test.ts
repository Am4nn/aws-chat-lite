import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Handler = (event: object) => void;
type Window = { url: string; visibilityState: string; focus?: () => Promise<void>; navigate?: (url: string) => Promise<void> };

const SCRIPT = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");
const NOTE = { title: "bea mentioned you in #general", body: "dev: hi", url: "/r/R/c/C", tag: "chat-C", urgency: "normal" };
const FCM = "https://fcm.googleapis.com/fcm/send/abc";

/** Runs sw.js against a fake worker global and returns its handlers with the fakes they call. */
function worker({ windows = [], endpoint = FCM }: { windows?: Window[]; endpoint?: string } = {}) {
  const handlers = new Map<string, Handler>();
  const self = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: vi.fn(),
    clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null), claim: vi.fn(async () => {}) },
    registration: {
      showNotification: vi.fn(async () => {}),
      pushManager: { getSubscription: async () => ({ endpoint }) },
    },
  };
  runInNewContext(SCRIPT, { self, URL });
  async function dispatch(type: string, event: object) {
    const waited: Promise<unknown>[] = [];
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => waited.push(p) });
    await Promise.all(waited);
  }
  return { self, dispatch, push: () => dispatch("push", { data: { json: () => NOTE } }) };
}

const visibleOn = (path: string): Window => ({ url: `https://chat.example${path}`, visibilityState: "visible" });

describe("service worker", () => {
  it("shows nothing when a visible tab is already on the notification's page", async () => {
    const { self, push } = worker({ windows: [visibleOn("/r/R/c/C")] });
    await push();
    expect(self.registration.showNotification).not.toHaveBeenCalled();
  });

  it("shows the notification when the visible tab is on another page, or the tab on it is hidden", async () => {
    for (const windows of [[visibleOn("/r/R/c/D")], [{ ...visibleOn("/r/R/c/C"), visibilityState: "hidden" }]]) {
      const { self, push } = worker({ windows });
      await push();
      expect(self.registration.showNotification).toHaveBeenCalledOnce();
      expect(self.registration.showNotification).toHaveBeenCalledWith(NOTE.title, expect.objectContaining({
        body: "dev: hi", tag: "chat-C", renotify: true, data: { url: "/r/R/c/C" },
      }));
    }
  });

  it("always shows one on Apple's push service, which revokes a subscription whose pushes show nothing", async () => {
    const { self, push } = worker({ windows: [visibleOn("/r/R/c/C")], endpoint: "https://web.push.apple.com/QKx" });
    await push();
    expect(self.registration.showNotification).toHaveBeenCalledOnce();
  });

  it("a click with no window open opens the notification's page", async () => {
    const { self, dispatch } = worker();
    const notification = { close: vi.fn(), data: { url: "/r/R/c/C" } };
    await dispatch("notificationclick", { notification });
    expect(notification.close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith("/r/R/c/C");
  });

  it("a click with a window open focuses it and takes it to the page", async () => {
    const tab = { ...visibleOn("/r/R/c/D"), focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
    const { self, dispatch } = worker({ windows: [tab] });
    await dispatch("notificationclick", { notification: { close: () => {}, data: { url: "/r/R/c/C" } } });
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith("/r/R/c/C");
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
});
