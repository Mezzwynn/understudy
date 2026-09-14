/**
 * Kill switch. The service worker kept a stale panel alive through several updates, which cost more
 * than offline mode ever gave. It now unregisters itself and empties every cache the first time it runs,
 * so no old page can survive in a browser.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", async (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
      try {
        await self.registration.unregister();
      } catch {}
      const clients = await self.clients.matchAll({ type: "window" });
      for (const c of clients) c.navigate(c.url);
    })(),
  );
});
self.addEventListener("fetch", () => {});
