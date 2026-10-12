/* Service worker for the attendance journal PWA.
   Precaches the app shell, serves it cache-first offline, and keeps
   runtime-cached copies of the CDN vendor chunks so installed apps
   open without network. version.json is always fetched from the
   network so the in-app update check keeps working. */
var CACHE_NAME = 'attendance-journal-v2';
var APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './offline.html'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);

  /* Always hit the network for the release manifest so update checks
     are never served from a stale cache. */
  if (url.pathname.endsWith('/version.json')) return;

  /* Page navigations: cached app shell first, offline page as last resort. */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('./index.html', { ignoreSearch: true })
          .then(function (cached) { return cached || caches.match('./offline.html'); });
      })
    );
    return;
  }

  /* Same-origin app shell: stale-while-revalidate. */
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(request, { ignoreSearch: true }).then(function (cached) {
          var network = fetch(request).then(function (response) {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          }).catch(function () { return cached; });
          return cached || network;
        });
      })
    );
    return;
  }

  /* Cross-origin static assets (CDN chunks): cache-first with background fill. */
  if (/^https?:$/.test(url.protocol)) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then(function (cached) {
        if (cached) {
          fetch(request).then(function (r) { if (r && r.ok) caches.open(CACHE_NAME).then(function (c) { c.put(request, r.clone()); }); }).catch(function () {});
          return cached;
        }
        return fetch(request).then(function (response) {
          if (response && (response.ok || response.type === 'opaque')) {
            caches.open(CACHE_NAME).then(function (c) { c.put(request, response.clone()); });
          }
          return response;
        });
      })
    );
  }
});
