const CACHE_VERSION = '1.0.2';
const CACHE_NAME = `arvi-app-shell-v${CACHE_VERSION}`;

const APP_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './version.json',
  './js/constants.js',
  './js/migrations.js',
  './js/db.js',
  './js/backup.js',
  './js/updater.js',
  './js/swipe.js',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  // Pre-cache the entire application shell so it works 100% standalone offline.
  // Intentionally do NOT call self.skipWaiting() here — updates activate ONLY when the user requests them.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_ASSETS.map((asset) =>
          cache.add(new Request(asset, { cache: 'reload' }))
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('arvi-app-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};

  // Explicit user-confirmed update activation
  if (data.type === 'APPLY_UPDATE') {
    self.skipWaiting();
    return;
  }

  // Explicit cache refresh if sw.js itself kept the same version hash
  if (data.type === 'REFRESH_CACHE') {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      caches.open(CACHE_NAME)
        .then((cache) =>
          Promise.all(
            APP_ASSETS.map((asset) =>
              cache.add(new Request(asset, { cache: 'reload' }))
            )
          )
        )
        .then(() => {
          if (port) port.postMessage({ ok: true });
        })
        .catch(() => {
          if (port) port.postMessage({ ok: false });
        })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Explicit manual update check bypasses the cache completely
  if (url.searchParams.has('arvi_update_check')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Strict Cache-First: zero network traffic during normal operation once installed
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;

      // Navigation fallback to cached index.html
      if (request.mode === 'navigate') {
        return caches.match('./index.html').then((indexRes) => indexRes || fetch(request));
      }

      return fetch(request).then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
