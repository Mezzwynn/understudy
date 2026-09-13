/**
 * sw.js — service worker for the control panel.
 *
 * The panel is a local page: everything it shows comes from /api/*, which needs the
 * bot running anyway. So the worker does two useful things and nothing clever:
 *   - keeps the shell (html, logo, manifest) so the app opens instantly and still
 *     opens when the server is briefly down, showing a clear "offline" state
 *   - never caches /api/*: a dashboard that shows yesterday's numbers is worse than
 *     one that says it cannot reach the bot
 */
const SHELL = "understudy-shell-v1";
const FILES = ["/", "/index.html", "/logo.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(FILES))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // never cache the live data
  if (url.pathname.startsWith("/api/")) return;

  // the shell: serve from cache, refresh in the background
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const fresh = fetch(event.request)
        .then((res) => {
          if (res && res.ok) caches.open(SHELL).then((c) => c.put(event.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});
