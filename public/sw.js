const CACHE_NAME = 'dots-and-boxes-v8';
// music.mp3 (~6 MB) is streamed with Range requests: never precached or
// runtime-cached (see fetch). Only the short effects are cached.
const NO_CACHE_AUDIO = new Set(['/sounds/music.mp3']);
const SHELL = [
  '/', '/index.html', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/sounds/boxclaim.mp3', '/sounds/error.mp3', '/sounds/linedraw.mp3',
  '/sounds/tap.mp3', '/sounds/win.mp3',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url)))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
async function cacheResponse(request, response) {
  // Only full 200 responses: Cache Storage rejects 206 Partial Content.
  if (response?.status === 200 && response.type === 'basic') {
    try { await (await caches.open(CACHE_NAME)).put(request, response.clone()); } catch (_) {}
  }
  return response;
}
async function networkFirst(request, navigation = false) {
  try { return await cacheResponse(request, await fetch(request)); }
  catch { return (await caches.match(request)) || (navigation && await caches.match('/index.html')) || Response.error(); }
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // Large audio goes straight to the network, with or without a Range header.
  if (NO_CACHE_AUDIO.has(url.pathname)) return;
  // Media elements use Range requests; pass them straight to the network
  // (never cached, never answered with a full cached 200).
  if (event.request.headers.has('range')) {
    event.respondWith(fetch(event.request));
    return;
  }
  const navigation = event.request.mode === 'navigate';
  const asset = /\.(?:js|css|png|mp3|json)$/.test(url.pathname) || url.pathname.startsWith('/assets/');
  if (navigation || asset) event.respondWith(networkFirst(event.request, navigation));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
