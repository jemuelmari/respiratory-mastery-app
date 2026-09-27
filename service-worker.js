/* ============================================================
   Respiratory Mastery — Service Worker
   Version: 3.1.0
   ============================================================
   
   IMPORTANT FOR THE INSTRUCTOR:
   Every time you update the app (new quiz, fixed typo, new unit),
   change ONLY the APP_VERSION number below. The cache will
   automatically refresh for all students on their next visit.
   
   Example: change '3.1.0' to '3.1.1' for a small fix,
            or to '3.2.0' for a new feature.
   ============================================================ */

const APP_VERSION = '3.2.0';

const CACHE_NAME   = `resp-mastery-v${APP_VERSION}`;
const RUNTIME_CACHE = `resp-mastery-runtime-v${APP_VERSION}`;

// Files that are always cached when the app first loads
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './about.html',
  './instructor-dashboard.html',
  './gradebook.html',
  './manifest.json',
  './icon.svg',
];

/* ------------------------------------------------------------
   1. INSTALL — download and cache the core files
   ------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing v${APP_VERSION}...`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Use addAll with individual error handling so one missing
        // file doesn't break the whole install
        return Promise.all(
          PRECACHE_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn(`[SW] Skipped precache for ${url}:`, err.message);
            })
          )
        );
      })
      .then(() => {
        console.log('[SW] Precache complete. Activating immediately.');
        return self.skipWaiting();
      })
      .catch((err) => console.error('[SW] Precache failed:', err))
  );
});

/* ------------------------------------------------------------
   2. ACTIVATE — clean up old caches from previous versions
   ------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating v${APP_VERSION}...`);
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => {
              // Delete any cache that isn't part of the current version
              return name !== CACHE_NAME && name !== RUNTIME_CACHE;
            })
            .map((name) => {
              console.log(`[SW] Deleting old cache: ${name}`);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
      .then(() => {
        console.log('[SW] Activation complete. Controlling all clients.');
      })
  );
});

/* ------------------------------------------------------------
   3. FETCH — decide how to serve every request
   ------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Ignore non-http(s) requests (e.g., chrome-extension://)
  if (!url.protocol.startsWith('http')) return;

  // -------- CASE A: Cross-origin requests (Google Apps Script, fonts, CDNs) --------
  if (url.origin !== self.location.origin) {
    // Network-first: try the network, fall back to cache if offline.
    // This is critical for the Google Apps Script backend — we always
    // want fresh data when online, but the app should still work offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache successful, cacheable responses
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, clone).catch(() => {});
            });
          }
          return response;
        })
        .catch(() => {
          // Offline — try runtime cache first, then fall back gracefully
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            // For API calls, return a JSON error so the app can handle it
            if (url.hostname.includes('script.google.com')) {
              return new Response(
                JSON.stringify({
                  success: false,
                  error: 'Offline — unable to reach backend'
                }),
                {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' }
                }
              );
            }
            // For other cross-origin (fonts, icons), return empty
            return new Response('', { status: 504 });
          });
        })
    );
    return;
  }

  // -------- CASE B: Same-origin HTML files (stale-while-revalidate) --------
  // Serve from cache instantly for speed, then update in background.
  if (request.destination === 'document' || url.pathname.endsWith('.html')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, clone).catch(() => {});
              });
            }
            return response;
          })
          .catch(() => cached || caches.match('./index.html'));

        // Return cached immediately if we have it; update happens in background
        return cached || networkFetch;
      })
    );
    return;
  }

  // -------- CASE C: Same-origin assets (CSS, JS, images, SVG) --------
  // Cache-first: serve from cache, fetch from network only if not cached.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Refresh the cache in the background for future visits
        event.waitUntil(
          fetch(request)
            .then((response) => {
              if (response && response.status === 200) {
                return caches.open(CACHE_NAME).then((cache) => cache.put(request, response));
              }
            })
            .catch(() => {})
        );
        return cached;
      }

      // Not in cache — fetch from network and cache it
      return fetch(request)
        .then((response) => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone).catch(() => {});
          });
          return response;
        })
        .catch(() => {
          // Fallback for navigation requests
          if (request.destination === 'document') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 504 });
        });
    })
  );
});

/* ------------------------------------------------------------
   4. MESSAGE — allow the app to trigger an immediate update
   ------------------------------------------------------------ */
// When the main app sends { type: 'SKIP_WAITING' }, activate the
// new service worker immediately instead of waiting for all tabs
// to close. This lets you show students an "Update available" banner.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skipping waiting — activating new version now.');
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});

console.log(`[SW] Service Worker loaded — version ${APP_VERSION}`);
