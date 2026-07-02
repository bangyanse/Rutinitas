const CACHE_NAME = 'rutin-v1.5';
const ASSETS = [
  './index.html',
  './manifest.json',
  './alarm.mp3'
];

// Install: cache semua file
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  // langsung aktif tanpa tunggu tab lama ditutup
  self.skipWaiting();
});

// Activate: hapus cache lama OTOMATIS
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
        console.log('Hapus cache lama:', k);
        return caches.delete(k);
      }))
    ).then(() => {
      // ambil alih semua tab yang terbuka sekarang
      return self.clients.claim();
    })
  );
});

// Fetch: network first, fallback ke cache
// Ini kunci utama — selalu coba ambil dari network dulu
self.addEventListener('fetch', e => {
  // skip request non-GET
  if(e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).then(res => {
      // kalau berhasil dapat dari network, update cache sekalian
      if(res && res.status === 200 && res.type === 'basic'){
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return res;
    }).catch(() => {
      // kalau offline, pakai cache
      return caches.match(e.request);
    })
  );
});

// Dengarkan pesan dari app untuk force update
self.addEventListener('message', e => {
  if(e.data === 'SKIP_WAITING') self.skipWaiting();
});
