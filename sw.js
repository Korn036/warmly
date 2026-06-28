/* Sovenn service worker - STALE-WHILE-REVALIDATE.
   Serve the cached shell instantly for a fast cold start, then refresh it in the
   background so the next open is current. Cache name is bumped each release; the new
   version precaches a fresh SHELL on install, so updates still land promptly. */
const CACHE = 'sovenn-0.59.0';
const SHELL = ['./','index.html','app.html','card.html','app.js','qr.js','capture.js','shuffle.js','memory.js','streak.js','notify.js','styles.css','logo.svg','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon-32.png','favicon-16.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // stale-while-revalidate: answer from cache instantly, refresh the cache in the background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
        return res;
      }).catch(() => cached || caches.match('index.html'));
      return cached || net;
    })
  );
});
