const CACHE_NAME = 'dots-and-boxes-v21';
const SHELL = [
  '/', '/index.html', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/sounds/boxclaim.mp3', '/sounds/error.mp3', '/sounds/linedraw.mp3',
  '/sounds/music.mp3', '/sounds/tap.mp3', '/sounds/win.mp3',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url)))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
async function cacheResponse(request, response) {
  if (response?.ok && response.type === 'basic') (await caches.open(CACHE_NAME)).put(request, response.clone());
  return response;
}
async function networkFirst(request, navigation = false) {
  try { return await cacheResponse(request, await fetch(request)); }
  catch { return (await caches.match(request)) || (navigation && await caches.match('/index.html')) || Response.error(); }
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate';
  const asset = /\.(?:js|css|png|mp3|json)$/.test(url.pathname) || url.pathname.startsWith('/assets/');
  if (navigation || asset) event.respondWith(networkFirst(event.request, navigation));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
