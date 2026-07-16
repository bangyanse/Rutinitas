const CACHE_NAME = 'rutin-v1.20';
const ASSETS = [
  './index.html',
  './manifest.json',
  './alarm.mp3',
  './finance.js'
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

// ====== WEB PUSH: alarm timer walau app ketutup ======
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err){ data = { title:'Rutin', body: e.data ? e.data.text() : 'Waktu target tercapai' }; }
  const title = data.title || 'Rutin';
  const options = {
    body: data.body || 'Waktu target kegiatan sudah tercapai!',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [200,100,200,100,200],
    tag: data.tag || 'rutin-alarm',
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || './index.html' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(
    self.clients.matchAll({type:'window', includeUncontrolled:true}).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.includes('index.html'));
      if(existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
