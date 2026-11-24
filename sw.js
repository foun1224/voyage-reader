/* VoyageReader Offline Service Worker */
const CACHE_NAME = 'voyage-reader-v1.0.0';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/db.js',
  './js/zip-reader.js',
  './js/pdf-reader.js',
  './js/epub-reader.js',
  './js/app.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  // Essential Traditional & Simplified Chinese CMaps for offline text PDFs
  './vendor/pdfjs/cmaps/UniCNS-UTF16-H.bcmap',
  './vendor/pdfjs/cmaps/UniCNS-UTF16-V.bcmap',
  './vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap',
  './vendor/pdfjs/cmaps/UniCNS-UTF8-H.bcmap',
  './vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap',
  './vendor/pdfjs/cmaps/ETen-B5-H.bcmap',
  './vendor/pdfjs/cmaps/ETenms-B5-H.bcmap',
  './vendor/pdfjs/cmaps/B5pc-H.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF16-H.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF16-V.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap',
  './vendor/pdfjs/cmaps/UniGB-UTF8-H.bcmap',
  './vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache individually so one missing optional file never aborts install
      await Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[SW] Precache warning:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          if (resp && resp.ok && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return resp;
        })
        .catch(() => {
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_OFFLINE') {
    caches.open(CACHE_NAME).then(async (cache) => {
      const keys = await cache.keys();
      event.ports[0]?.postMessage({
        ok: true,
        cacheName: CACHE_NAME,
        cachedCount: keys.length,
        expectedCore: CORE_ASSETS.length,
      });
    });
  }
});
