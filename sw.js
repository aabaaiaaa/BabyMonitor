/**
 * sw.js — Service Worker (TASK-002)
 *
 * This is a placeholder stub. The full offline caching implementation
 * (pre-caching all app assets and CDN resources using a cache-first
 * strategy) will be completed in TASK-002.
 *
 * The stub is registered so that the app can already be added to the
 * home screen and receive the manifest, but it does not yet provide
 * offline support.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME    = `baby-monitor-${CACHE_VERSION}`;

// ---------------------------------------------------------------------------
// Install — pre-cache shell assets (TASK-002 will expand this list)
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  // Skip waiting so the new service worker activates immediately
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        '/',
        '/index.html',
        '/baby.html',
        '/parent.html',
        '/css/main.css',
        '/css/baby.css',
        '/css/parent.css',
        '/js/main.js',
        '/js/baby.js',
        '/js/parent.js',
        '/js/qr.js',
        '/js/webrtc.js',
        '/js/storage.js',
        '/manifest.json',
      ])
    )
  );
});

// ---------------------------------------------------------------------------
// Activate — clean up old caches
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch — cache-first strategy (TASK-002 will add CDN caching)
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests in this stub
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful responses
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
