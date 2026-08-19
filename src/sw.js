/**
 * Service worker — offline app shell, plus an update the player opts into.
 *
 * TEMPLATE, not a module. Nothing imports this file and Vite never puts it
 * through the module graph; the `gelcube-service-worker` plugin in
 * vite.config.js stamps `__SW_BUILD__` / `__SW_PRECACHE__` and emits the
 * result as `dist/sw.js`. So: no imports, no bundler syntax, ES2020 only.
 *
 * The deal this file makes with src/swClient.js:
 *
 *   install   precache the shell, then STOP. No skipWaiting() — a new worker
 *             sits in `waiting` until the player taps Refresh, so a deploy can
 *             never swap the bundle out from under a live run.
 *   message   {type:'SKIP_WAITING'} is that tap arriving. Only then do we
 *             take over, and swClient reloads on `controllerchange`.
 *   activate  bin every cache that isn't ours.
 *
 * Because navigations are answered from the cache, the `no-store` header on
 * index.html (see public/_headers) no longer governs what a returning player
 * sees — this lifecycle does. That is the whole reason the update prompt
 * exists; without it a bad deploy would be sticky.
 */

const BUILD = '__SW_BUILD__';
const PRECACHE_PATHS = __SW_PRECACHE__;

const SHELL_CACHE = `gelcube-shell-${BUILD}`;
/**
 * Audio is deliberately NOT keyed by build. The mp3s are optional, large, and
 * change on their own schedule; re-downloading them on every deploy would be
 * the worst trade in the project.
 */
const AUDIO_CACHE = 'gelcube-audio-v1';
const KEEP = [SHELL_CACHE, AUDIO_CACHE];

// Resolved against the worker's own URL rather than assumed to be root-
// relative, so the game keeps working if it is ever served from a subpath.
const SHELL_URLS = new Set(PRECACHE_PATHS.map((p) => new URL(p, self.location).href));
const INDEX_URL = new URL('index.html', self.location).href;
const AUDIO_PREFIX = new URL('audio/', self.location).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // `reload` forces the network: an HTTP cache still holding the previous
      // deploy's index.html must not be allowed to seed the new shell.
      cache.addAll([...SHELL_URLS].map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Range requests are for media seeking; a partial response must never be
  // stored as if it were the whole file.
  if (req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Every navigation resolves to the cached shell — this is what makes the
  // game open with no signal. Freshness is the update prompt's job, not this
  // handler's.
  if (req.mode === 'navigate') {
    event.respondWith(caches.match(INDEX_URL).then((hit) => hit || fetch(req)));
    return;
  }

  if (SHELL_URLS.has(url.href)) {
    event.respondWith(cacheFirst(SHELL_CACHE, req));
    return;
  }

  if (url.pathname.startsWith(AUDIO_PREFIX)) {
    event.respondWith(cacheFirst(AUDIO_CACHE, req));
    return;
  }

  // Anything else is left to the network untouched.
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;

  const res = await fetch(req);
  // Only same-origin 200s. `public/audio/` is allowed to be empty, and a 404
  // for a missing optional mp3 must never be cached as if it were the file.
  if (res && res.status === 200 && res.type === 'basic') {
    cache.put(req, res.clone());
  }
  return res;
}
