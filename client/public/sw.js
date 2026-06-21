/* eslint-disable */
/**
 * Sail-sim asset cache (production only — registered from main.ts behind environment.production).
 *
 * Goal: skip re-downloading the heavy, rarely-changing game assets (vessel/crew/harbor/scatter GLBs, their
 * companion manifests + textures, and UI images) on every page load. The browser's HTTP cache already
 * revalidates these via ETag, but that still costs a round-trip per asset on a high-latency link; serving
 * them from the Cache API makes a returning player's load effectively instant and resilient to a flaky network.
 *
 * Strategy: STALE-WHILE-REVALIDATE, scoped to the static asset routes only (/geometry/ and /images/):
 *   - respond from cache immediately when present,
 *   - in the background fetch a fresh copy and update the cache (so a re-deployed asset is picked up on the
 *     NEXT load — assets are stable within a deploy, so this never serves a wrong asset mid-session).
 * The app shell (index.html, hashed JS/CSS bundles) is deliberately NOT handled here — Angular's content
 * hashing + the browser cache own that, so a deploy can never be masked by a stale shell.
 *
 * Dev (ng serve) does NOT register this SW, so the server's `Cache-Control: no-cache` + ETag revalidation of
 * re-exported GLBs keeps working unchanged — no stale-asset surprises while iterating on models.
 */

const CACHE = 'sail-assets-v1';

// Only these path segments are cached (the static asset routes). Everything else (API, WS, app shell) passes
// straight through to the network.
const ASSET_PATHS = ['/geometry/', '/images/'];

self.addEventListener('install', (event) => {
  self.skipWaiting();   // activate this SW as soon as it's installed (no waiting for old tabs to close)
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any older asset caches (bump CACHE to invalidate everything on a breaking change).
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE && n.startsWith('sail-assets-')).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Should this request be served from / stored in the asset cache? GET only, http(s) only, on a static route. */
function isCacheable(request) {
  if (request.method !== 'GET') return false;
  // A ranged request (audio seek, partial fetch) returns a 206 we must not cache — let it go to the network.
  if (request.headers.has('range')) return false;
  let url;
  try { url = new URL(request.url); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return ASSET_PATHS.some((p) => url.pathname.includes(p));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheable(request)) return;   // not ours → default browser handling

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);

      // Background revalidate: fetch a fresh copy and update the cache for next time. Only store a clean,
      // complete 200 (skip opaque/redirect/206/errors so we never cache a broken asset).
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => undefined);

      // Stale-while-revalidate: serve cache now if we have it, else wait on the network.
      if (cached) { event.waitUntil(network); return cached; }
      const fresh = await network;
      return fresh || new Response('', { status: 504, statusText: 'asset unavailable (offline, not cached)' });
    })(),
  );
});
