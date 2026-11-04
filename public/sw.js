/**
 * Service worker — what makes the installed app open instantly and work offline.
 *
 * Strategy per request type:
 *   page loads           network first (4 s), cached shell when offline
 *   /assets/*            cache first — Vite hashes these filenames, so a cached
 *                        copy can never be stale
 *   highs.wasm, fonts,   stale-while-revalidate: instant from cache, refreshed
 *   icons                in the background
 *   /api/*, /data/*      network first, last good copy when offline — so the app
 *                        shows yesterday's projections on the Tube rather than
 *                        nothing
 *
 * Bump VERSION only to force every installed copy to drop its caches.
 */

const VERSION = "fd-v1";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const DATA = `${VERSION}-data`;
const MAX_STATIC = 80;
const NAV_TIMEOUT_MS = 4000;

const BASE = new URL(self.registration.scope).pathname; // "/" on Vercel, "/fantasy-drafter/" on Pages
const SHELL_URLS = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icons/icon-192.png`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}

/** Tags a cached data response so the app can say it's showing an offline copy. */
function markOffline(response) {
  const headers = new Headers(response.headers);
  headers.set("x-fd-offline", "1");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function networkFirst(request, cacheName, { timeoutMs, fallbackUrl, mark = false } = {}) {
  const cache = await caches.open(cacheName);
  // Data requests revalidate with the server. Without this the browser's own
  // HTTP cache (honouring stale-while-revalidate) can answer instead, and the
  // app would show hour-old numbers labelled "live" — online or off.
  if (mark) request = new Request(request, { cache: "no-cache" });
  try {
    const response = await (timeoutMs
      ? Promise.race([
          fetch(request),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
        ])
      : fetch(request));
    if (response.ok) cache.put(fallbackUrl ?? request, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(fallbackUrl ?? request)) ?? (fallbackUrl ? await caches.match(fallbackUrl) : undefined);
    if (cached) return mark ? markOffline(cached) : cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC);
    await cache.put(request, response.clone());
    trim(STATIC, MAX_STATIC);
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok || response.type === "opaque") cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? refresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    // Hash routing means every page is the same document: cache it as the shell.
    event.respondWith(networkFirst(request, SHELL, { timeoutMs: NAV_TIMEOUT_MS, fallbackUrl: BASE }));
    return;
  }

  if (url.origin === self.location.origin) {
    const path = url.pathname.slice(BASE.length - 1);
    if (path.startsWith("/assets/")) return event.respondWith(cacheFirst(request));
    if (path.startsWith("/api/") || path.startsWith("/data/")) {
      return event.respondWith(networkFirst(request, DATA, { mark: true }));
    }
    if (path.endsWith(".wasm") || path.startsWith("/icons/") || path.endsWith(".webmanifest")) {
      return event.respondWith(staleWhileRevalidate(request));
    }
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request));
  }
});
