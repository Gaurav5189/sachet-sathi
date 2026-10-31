/* SachetSathi service worker.
 *
 * Strategy:
 *   shell (/, /app.js, /style.css, icons, manifest, safety pack) → precache,
 *     cache-first afterwards (it only changes on deploy, and the cache name
 *     carries the version)
 *   GET /api/* → network-first with a short timeout, falling back to the last
 *     good response, so an offline cold start still shows real alerts
 *   navigations → network-first, falling back to the cached shell
 *   POST → never cached; the app queues reports in IndexedDB instead
 */

const VERSION = 'v4';
const SHELL_CACHE = `sachet-shell-${VERSION}`;
const API_CACHE = `sachet-api-${VERSION}`;
const SHELL = [
  '/',
  '/index.html',
  '/tokens.css',
  '/style.css',
  '/i18n.js',
  '/map-data.js',
  '/app.js',
  '/manifest.json',
  '/safety-pack.json',
  '/icon-192.png',
  '/icon-512.png',
];
const API_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Add individually: one 404 must not fail the whole install.
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch((error) => console.warn('precache miss', url, error))),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, API_CACHE]);
      for (const key of await caches.keys()) {
        if (!keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-SachetSathi-Cache', 'hit');
      return new Response(cached.body, { status: cached.status, headers });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      networkFirst(request, API_CACHE, API_TIMEOUT_MS).catch(
        () =>
          new Response(
            JSON.stringify({
              error: 'offline',
              hint: 'No network and no cached copy yet. Reconnect and reload.',
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request, SHELL_CACHE, API_TIMEOUT_MS).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/'));
      }),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    })(),
  );
});
