/**
 * sw.js — Service Worker: PWA offline caching (TASK-002)
 *
 * Strategy: cache-first for all app assets and CDN libraries.
 *
 * On first visit:
 *   - All app shell assets (HTML, CSS, JS) are pre-cached during `install`.
 *   - CDN library scripts are fetched and pre-cached during `install` so the
 *     app is fully usable offline after the very first visit.
 *
 * On subsequent visits (including offline):
 *   - The `fetch` handler serves everything from cache.
 *   - Any asset not yet in cache is fetched from the network and cached for
 *     next time (dynamic caching as a fallback).
 *
 * CDN origins cached by this Service Worker:
 *   - https://cdnjs.cloudflare.com  (qrcode.js)
 *   - https://cdn.jsdelivr.net      (jsQR, PeerJS)
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME    = `baby-monitor-${CACHE_VERSION}`;

// ---------------------------------------------------------------------------
// App shell assets to pre-cache on install (relative to SW location)
// ---------------------------------------------------------------------------

const APP_ASSETS = [
  './',
  './index.html',
  './baby.html',
  './parent.html',
  './css/main.css',
  './css/baby.css',
  './css/parent.css',
  './js/main.js',
  './js/baby.js',
  './js/parent.js',
  './js/qr.js',
  './js/webrtc.js',
  './js/storage.js',
  './manifest.json',
  './icons/icon.svg',
];

// ---------------------------------------------------------------------------
// CDN library URLs to pre-cache on install
// All CDN origins used by this app must be listed here.
// ---------------------------------------------------------------------------

const CDN_ASSETS = [
  // QR code generation (used by qr.js as window.QRCode)
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  // QR code scanning (used by qr.js as window.jsQR)
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
  // PeerJS WebRTC signaling (used by webrtc.js as window.Peer)
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
];

// Set of CDN origins handled by this Service Worker (for fetch routing).
const CDN_ORIGINS = new Set([
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
]);

// ---------------------------------------------------------------------------
// Install — pre-cache all assets (app shell + CDN libraries)
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  // Activate this SW immediately without waiting for old pages to close.
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {

      // 1. Cache all same-origin app shell assets in one batch.
      await cache.addAll(APP_ASSETS);

      // 2. Cache CDN library scripts individually.
      //    Using mode:'cors' so we get a readable (non-opaque) CORS response
      //    that matches what the browser requests when crossorigin="anonymous"
      //    is set on the <script> tags in the HTML.
      const cdnResults = await Promise.allSettled(
        CDN_ASSETS.map(async (url) => {
          const req  = new Request(url, { mode: 'cors' });
          const resp = await fetch(req);
          if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
          await cache.put(req, resp);
          console.log('[sw] Pre-cached CDN asset:', url);
        })
      );

      // Log any CDN pre-cache failures (non-fatal — dynamic caching is the fallback).
      for (const result of cdnResults) {
        if (result.status === 'rejected') {
          console.warn('[sw] CDN pre-cache failed (will cache on first use):', result.reason);
        }
      }
    })
  );
});

// ---------------------------------------------------------------------------
// Activate — purge old caches and take control of all open clients
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[sw] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch — cache-first strategy for app assets and CDN libraries
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  // Only handle GET requests.
  if (event.request.method !== 'GET') return;

  const url        = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCdnOrigin  = CDN_ORIGINS.has(url.origin);

  // Ignore requests to origins we don't manage.
  if (!isSameOrigin && !isCdnOrigin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Cache hit — serve immediately.
      if (cached) return cached;

      // Cache miss — fetch from network, cache the response for next time.
      return fetch(event.request).then((response) => {
        // Only cache successful responses.
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // Network completely unavailable and no cached response.
        // For navigation requests, try returning a cached index.html.
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        // For other resources, return a minimal error response.
        return new Response('Offline — resource not cached', {
          status:  503,
          headers: { 'Content-Type': 'text/plain' },
        });
      });
    })
  );
});
