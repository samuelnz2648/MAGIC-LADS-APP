// Keeps the app's own files on the phone so it opens without signal.
// Bump VERSION whenever the app's files change, so phones pick up the update.
const VERSION = 'magic-lads-v16';
// Commander card images the app has stored (CARD_CACHE in app.js). Kept across versions so they're never fetched twice.
const CARD_CACHE = 'magic-lads-cards';
const SHELL = [
  'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/wordmark.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's own short-term cache, so a new version never saves old files.
  event.waitUntil(caches.open(VERSION)
    .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== CARD_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app's files: answer from the cache straight away, refresh the cache in the background.
// Anything else (the tracker, Scryfall) goes straight to the network.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Every page of the app is index.html; files are kept by their address without any ?query.
  const navigate = req.mode === 'navigate';
  const key = navigate ? 'index.html' : url.pathname;
  const network = fetch(req, { cache: 'no-cache' });   // asks GitHub if the file changed
  // Registered first, so the copy is taken before the page starts reading the answer.
  event.waitUntil(network.then(res => {
    if (!res.ok || res.type !== 'basic') return undefined;
    const copy = res.clone();
    return caches.open(VERSION).then(cache => cache.put(key, copy));
  }).catch(() => {}));
  event.respondWith(caches.open(VERSION)
    .then(cache => cache.match(key))
    .then(cached => cached || network)
    .catch(() => (navigate ? caches.match('index.html') : Response.error())));
});
