const CACHE = 'bu-v2';
const PRECACHE = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Network-first everywhere, so deploys show up on next load instead of being
// masked by a stale cached copy. Cache is only a fallback for offline use.
//
// API routes are skipped entirely: their data (playlist, streams, leaderboard)
// changes throughout the day, so falling back to a cached response on a
// flaky/cold-start network would silently show stale data instead of just
// failing — e.g. a cached Day 23 playlist reappearing on app relaunch even
// after Day 24 has gone live, until the next manual reload catches up.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Only cache same-origin requests; skip external APIs (Last.fm, ListenBrainz, etc.)
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone(); // clone synchronously before returning res
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
