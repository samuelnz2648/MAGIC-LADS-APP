// Keeps the app's own files on the phone so it opens without signal.
// Bump VERSION whenever the app's files change, so phones pick up the update.
const VERSION = 'magic-lads-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app's files: answer from the cache straight away, refresh the cache in the background.
// Anything else (the tracker, Scryfall) goes straight to the network.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const key = req.mode === 'navigate' ? 'index.html' : req;
  const network = fetch(req).then(res => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(VERSION).then(cache => cache.put(key, copy));
    }
    return res;
  });
  event.respondWith(
    caches.match(key, { ignoreSearch: true }).then(cached => cached || network)
      .catch(() => caches.match('index.html')),
  );
  event.waitUntil(network.then(() => undefined, () => undefined));
});
