const CACHE_NAME = 'sketch3d-v4';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/main.js',
  '/js/viewport.js',
  '/js/planes.js',
  '/js/drawing.js',
  '/js/ui.js',
  '/js/curves.js',
  '/js/snap.js',
  '/js/storage.js',
  '/manifest.json',
];

// Install: precache local app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for CDN resources, cache-first for local app shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for CDN requests (unpkg, etc.)
  if (url.hostname !== self.location.hostname) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for local app files
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
