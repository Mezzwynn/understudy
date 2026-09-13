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
const SHELL = "understudy-shell-v2";
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

  // The panel itself: NETWORK FIRST. It is a local page, so the network is always
  // faster than reading the question, and serving a cached page would hide every
  // update (which is exactly what happened: the character tab looked unchanged
  // because the old html was cached). The cache is only a fallback for when the
  // server is briefly down.
  const isPage = event.request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html";
  if (isPage) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res && res.ok) caches.open(SHELL).then((c) => c.put("/index.html", res.clone()));
          return res;
        })
        .catch(() => caches.match("/index.html").then((hit) => hit || caches.match("/"))),
    );
    return;
  }

  // assets (the logo, the manifest): cache first, they never change mid-session
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        if (res && res.ok) caches.open(SHELL).then((c) => c.put(event.request, res.clone()));
        return res;
      });
    }),
  );
});
