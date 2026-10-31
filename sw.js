// Service worker di Vault: tiene in cache i file dell'app per il funzionamento offline.
// A ogni nuova versione dei file, aumentare VERSION qui e APP_VERSION in sw-register.js:
// i telefoni scaricheranno i file nuovi e cancelleranno quelli vecchi.
const VERSION = 'vault-v3.4'; // stesso numero di APP_VERSION in sw-register.js
const FILES = [
  './', 'index.html', 'editor.html', 'editor.js', 'viewer.html', 'viewer.js',
  'vault-crypto.js', 'sw-register.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('vault-') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Prima la cache (avvio istantaneo e offline), poi la rete per ciò che manca.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req))
  );
});
