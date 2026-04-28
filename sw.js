// sw.js - Service Worker cho Phả Hệ Đại Việt
const CACHE_NAME = 'phagia-vi-v1';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/leaflet.css',
  './assets/js/leaflet.js',
  './assets/fontawesome/css/all.min.css'
  // Thêm các file CSS, JS quan trọng khác nếu cần
];

// Cài đặt cache
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// Lấy dữ liệu từ cache nếu có, nếu không thì fetch từ mạng
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

// Xóa cache cũ khi có phiên bản mới
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => Promise.all(
      cacheNames.map(cacheName => {
        if (!cacheWhitelist.includes(cacheName)) {
          return caches.delete(cacheName);
        }
      })
    ))
  );
});