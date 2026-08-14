// Service Worker for Dots and Boxes PWA
const CACHE_NAME = 'dots-and-boxes-v2.7.0';
const OFFLINE_PAGE = '/offline.html';

// Assets to cache immediately on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/main.js',
  '/js/app-firebase.js',
  '/js/firebase-config.js',
  '/js/canvas.js',
  '/js/game.js',
  '/js/sounds.js',
  '/js/qrcode.js',
  '/manifest.json',
  '/offline.html'
];

// Install event - cache essential assets
self.addEventListener('install', (event) => {
  console.log('[SW] Install event');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Precaching assets');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate event');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache with network fallback
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Skip Firebase requests (they need to be live)
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('googleapis.com')) {
    return;
  }

  // Network-first strategy for API calls
  if (url.pathname.startsWith('/api/') || request.method !== 'GET') {
    event.respondWith(
      fetch(request)
        .catch(() => {
          return caches.match(OFFLINE_PAGE);
        })
    );
    return;
  }

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          // Return cached version and update cache in background
          fetchAndCache(request);
          return cachedResponse;
        }

        // Not in cache, fetch from network
        return fetch(request)
          .then((response) => {
            // Cache successful responses
            if (response.status === 200) {
              const responseClone = response.clone();
              caches.open(CACHE_NAME)
                .then((cache) => {
                  cache.put(request, responseClone);
                });
            }
            return response;
          })
          .catch(() => {
            // Network failed, show offline page for navigation requests
            if (request.mode === 'navigate') {
              return caches.match(OFFLINE_PAGE);
            }
          });
      })
  );
});

// Helper function to fetch and update cache in background
function fetchAndCache(request) {
  fetch(request)
    .then((response) => {
      if (response.status === 200) {
        const responseClone = response.clone();
        caches.open(CACHE_NAME)
          .then((cache) => {
            cache.put(request, responseClone);
          });
      }
    })
    .catch(() => {
      // Silently fail for background updates
    });
}

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});

// Background sync for offline actions (optional enhancement)
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync event:', event.tag);
  
  if (event.tag === 'sync-game-data') {
    event.waitUntil(syncGameData());
  }
});

async function syncGameData() {
  // Placeholder for syncing offline game data when connection is restored
  console.log('[SW] Syncing game data...');
  return Promise.resolve();
}

// Push notification support (optional enhancement)
self.addEventListener('push', (event) => {
  console.log('[SW] Push notification received');
  
  const options = {
    body: event.data ? event.data.text() : 'New game invitation!',
    icon: '/images/icon-192.png',
    badge: '/images/icon-72.png',
    vibrate: [200, 100, 200],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'play',
        title: 'Play Now',
        icon: '/images/icon-72.png'
      },
      {
        action: 'close',
        title: 'Close',
        icon: '/images/icon-72.png'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('Dots and Boxes', options)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification click:', event.action);
  
  event.notification.close();

  if (event.action === 'play') {
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});
