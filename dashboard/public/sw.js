/**
 * The dashboard's service worker, which receives pushes when no tab is open.
 *
 * It caches only the content-hashed assets, which cannot go stale. Everything
 * else goes to the network, so a cached bundle never talks to a newer API.
 *
 * Plain JavaScript, because it is outside the Vite graph and served as is.
 */

/* global self, clients, caches */

/** Where the content-hashed assets are kept. */
const ASSET_CACHE = 'boxes-assets-v1';

/** The bundle directory whose filenames carry a content hash. */
const ASSET_PATH = '/assets/';

/**
 * Takes over as soon as a new copy is installed, so no push reaches an old
 * handler.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      // Drops the caches of older versions.
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== ASSET_CACHE).map((n) => caches.delete(n)));
      await clients.claim();
    })(),
  ),
);

/**
 * Serves a content-hashed asset from the cache, and caches it on the first
 * request. Other requests get no answer from here and go to the network.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(ASSET_PATH)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      // A 404 or 502 during a deploy must not become the answer for good.
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })(),
  );
});

/**
 * Shows one notification per push, even for a payload that fails to parse.
 * Browsers revoke the subscription of a worker that shows nothing.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'Boxes';
  const options = {
    body: payload.body || 'A box wants your attention.',
    // A notification with the same tag replaces the older one.
    tag: payload.tag || 'boxes',
    renotify: Boolean(payload.tag),
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Opens the notification's URL in an open Boxes window, or in a new window
 * when none is open.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        return client.focus().then((focused) => {
          // Some browsers lack navigate() for a client this worker does not
          // control. The focused window is still better than a second one.
          if (typeof focused.navigate !== 'function') return focused;
          return focused.navigate(url).catch(() => focused);
        });
      }
      return clients.openWindow(url);
    }),
  );
});

/**
 * Subscribes again and registers the new subscription with the orchestrator
 * when the push service rotates the old one out. Safari does this on its own
 * schedule.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = await fetch('/api/push/key')
        .then((res) => res.json())
        .then((body) => body.publicKey);
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The same label the page sends, so the deployment's list stays
        // readable.
        body: JSON.stringify({
          ...subscription.toJSON(),
          label: navigator.userAgent.slice(0, 100),
        }),
      });
    })().catch(() => {
      // The page registers its subscription again on its next load.
    }),
  );
});
