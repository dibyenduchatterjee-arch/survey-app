// Service worker: makes the app shell open with no network.
//
//   * The shell (HTML, CSS, JS, manifest) is cached on install and served
//     cache-first. Bump VERSION on every release: the new worker precaches into a
//     new cache and, on activate, deletes the old ones.
//   * API calls are NEVER cached and never answered by this worker. Anything under
//     /api/ and any non-GET request is left to the browser, so a stale form list or
//     a replayed upload cannot come out of a cache. Offline, those simply fail,
//     which is what the sync queue is for.
//   * Data lives in IndexedDB, not here.

const VERSION = 'v4';
const CACHE = `evac-shell-${VERSION}`;

// Relative to the worker's own location, so the app works under any base path.
// A file that does not exist in this build (404) is skipped; a network or server
// error fails the install, so a half-cached shell is never activated.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'css/app.css',
  'js/db.js',
  'js/auth.js',
  'js/projects.js',
  'js/projectkey.js',
  'config.js',
  'js/sync.js',
  'js/expr.js',
  'js/formengine.js',
  'js/i18n.js',
  'js/render.js',
  'js/app.js',
];

const scoped = path => new URL(path, self.registration.scope).href;

// Test seam: lets the browser test cut this worker's network without touching the
// machine's. It only ever makes the worker's own network calls fail.
let forceOffline = false;
const network = req => (forceOffline ? Promise.reject(new TypeError('offline (test)')) : fetch(req));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of SHELL) {
      const res = await fetch(new Request(scoped(path), { cache: 'reload' }));
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`shell file ${path} failed to download (${res.status})`);
      await cache.put(scoped(path), res);
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('evac-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const msg = event.data;
  if (msg && msg.type === 'test-offline') {
    forceOffline = !!msg.on;
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true, offline: forceOffline });
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;   // never cached, never intercepted

  const key = url.origin + url.pathname;   // the query string is ignored, so ?v= cache-busters still hit
  const inShell = SHELL.some(p => scoped(p) === key);
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // config.js holds the Apps Script address, which the owner edits after install: network first, so
    // a new address is picked up at once, and the cached copy only when offline.
    if (url.pathname.endsWith('/config.js')) {
      try {
        const fresh = await network(req);
        if (fresh.ok) await cache.put(key, fresh.clone());
        return fresh;
      } catch (err) {
        const old = await cache.match(key);
        if (old) return old;
        throw err;
      }
    }
    if (inShell) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    try {
      return await network(req);
    } catch (err) {
      // A page navigation while offline gets the app, which then works from IndexedDB.
      if (req.mode === 'navigate') {
        const home = await cache.match(scoped('index.html')) || await cache.match(scoped('./'));
        if (home) return home;
      }
      throw err;
    }
  })());
});
