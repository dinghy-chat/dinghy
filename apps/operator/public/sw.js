// Shows every push as a notification, because browsers end a subscription that stays silent.
const FALLBACK = { title: "Dinghy", body: "You have a new message.", tag: "dinghy", url: "/" };

function parse(data) {
  try {
    return { ...FALLBACK, ...data.json() };
  } catch {
    return FALLBACK;
  }
}

self.addEventListener("push", (event) => {
  const alert = event.data === null ? FALLBACK : parse(event.data);
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      // The event's ID, so a send repeated after a crash replaces the first one.
      tag: alert.tag,
      icon: "/assets/icon.svg",
      data: { url: alert.url },
    }),
  );
});

// A new version replaces the old one at once, so an app left open for days gets its fixes. It is safe
// because this worker has no fetch handler and no cache: nothing a page loaded can disagree with it.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

// The tab that turned on alerts has no worker until now, and an uncontrolled tab cannot navigate.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// The conversation a click asked for, until the window it opened asks for it. On an iPhone, a home
// screen app that starts from a click can open on its start page and not on the click's address.
let pending = null;
const PENDING_MS = 10_000;

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const first = open[0];
      if (first !== undefined) {
        // The open app moves to the conversation itself, with no reload. A home screen app on an
        // iPhone ignores navigate() and stays on the page it showed.
        first.postMessage({ type: "dinghy:open", url });
        return first.focus();
      }
      // The worker stays awake until the new window asks for the address, or for a few seconds.
      const asked = new Promise((resolve) => {
        pending = { url, resolve };
        setTimeout(resolve, PENDING_MS);
      });
      await self.clients.openWindow(url);
      await asked;
      pending = null;
    })(),
  );
});

// A window that starts asks for a click's address it may have missed.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "dinghy:ready" || pending === null) return;
  event.source?.postMessage({ type: "dinghy:open", url: pending.url });
  pending.resolve();
});
