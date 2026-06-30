/* eslint-disable */
/**
 * Sail-sim asset cache (production only — registered from main.ts behind environment.production).
 *
 * Goal: skip re-downloading the heavy game assets on every page load, WITHOUT ever serving a stale model after a
 * re-deploy (which used to happen and read as "my fix didn't take").
 *
 * Two strategies, by route:
 *   - /geometry/  (vessel/crew/harbor GLBs + companion manifests — these CHANGE as we iterate): NETWORK-FIRST.
 *     Always fetch the fresh copy; fall back to cache only when the network fails (offline). So a re-exported GLB
 *     shows up on the very next load — no "reload twice" / stale-while-revalidate lag. Costs one revalidating
 *     round-trip per asset, which the browser HTTP cache (ETag) makes cheap anyway.
 *   - /images/  (UI art — stable within a release): STALE-WHILE-REVALIDATE for an instant returning-player load.
 * The app shell (index.html, hashed JS/CSS bundles) is NOT handled here — Angular's content hashing + the browser
 * cache own that, so a deploy can never be masked by a stale shell.
 *
 * Dev (ng serve) does NOT register this SW, so the server's `Cache-Control: no-cache` + ETag revalidation keeps
 * working unchanged while iterating on models.
 */

const CACHE = 'sail-assets-v2';   // bump to invalidate ALL prior caches on activate (clears any stale GLBs)

const NETWORK_FIRST = ['/geometry/'];   // changes during iteration → always fetch fresh
const STALE_OK      = ['/images/'];      // stable → serve instantly from cache, revalidate in the background

self.addEventListener('install', (event) => {
  self.skipWaiting();   // activate this SW as soon as it's installed (no waiting for old tabs to close)
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE && n.startsWith('sail-assets-')).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Which strategy (if any) handles this request. GET + http(s) only; a ranged request (206) is never cached. */
function strategyFor(request) {
  if (request.method !== 'GET' || request.headers.has('range')) return null;
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (NETWORK_FIRST.some((p) => url.pathname.includes(p))) return 'network';
  if (STALE_OK.some((p) => url.pathname.includes(p))) return 'stale';
  return null;
}

const storable = (r) => r && r.status === 200 && r.type === 'basic';

self.addEventListener('fetch', (event) => {
  const strat = strategyFor(event.request);
  if (!strat) return;   // not ours → default browser handling (API, WS, app shell)

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      if (strat === 'network') {
        // NETWORK-FIRST: fresh model every load; cache is only the offline fallback.
        try {
          const response = await fetch(event.request);
          if (storable(response)) cache.put(event.request, response.clone()).catch(() => {});
          return response;
        } catch {
          const cached = await cache.match(event.request);
          return cached || new Response('', { status: 504, statusText: 'asset unavailable (offline, not cached)' });
        }
      }

      // STALE-WHILE-REVALIDATE (images): serve cache now, refresh for next time.
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => { if (storable(response)) cache.put(event.request, response.clone()).catch(() => {}); return response; })
        .catch(() => undefined);
      if (cached) { event.waitUntil(network); return cached; }
      const fresh = await network;
      return fresh || new Response('', { status: 504, statusText: 'asset unavailable (offline, not cached)' });
    })(),
  );
});
