// Shows chat-lite's push notifications and opens their page on a click. A plain script, served as is: a service
// worker is loaded by the browser on its own, outside the app's bundles.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  if (event.data) event.waitUntil(show(event.data.json()));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(open(event.notification.data.url));
});

async function show(note) {
  if (await alreadyOnPage(note.url)) return;
  await self.registration.showNotification(note.title, {
    body: note.body, tag: note.tag, renotify: true, data: { url: note.url }, icon: "/icon", badge: "/icon",
  });
}

// Safari revokes a subscription after a few pushes that show nothing, so on Apple's push service one always shows.
async function alreadyOnPage(url) {
  const subscription = await self.registration.pushManager.getSubscription();
  if (subscription && new URL(subscription.endpoint).hostname.endsWith("push.apple.com")) return false;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((w) => w.visibilityState === "visible" && new URL(w.url).pathname === url);
}

// Only windows this worker controls can be navigated, so an uncontrolled tab is left alone and a new one opens.
async function open(url) {
  const [win] = await self.clients.matchAll({ type: "window" });
  if (!win) return self.clients.openWindow(url);
  await win.focus();
  return win.navigate(url);
}
