var CACHE_NAME = 'pwa-cache-v1';
const OFFLINE_URL = '/offline.html';

var urlsToCache = [
  '/',
  '/index.html',
  '/main.js',
  '/manifest.json',
  '/assets/icon-phone-192.png',
  '/assets/icon-phone-512.png',
  OFFLINE_URL
];

self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).catch(() => {
        // Если запросили HTML — отдать offline.html
        // if (event.request.mode === 'navigate') {
        //   return caches.match(OFFLINE_URL);
        // }
      });
    })
  );
});


self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windows => {
        if (windows.length > 0) return windows[0].focus();
        return clients.openWindow('/');
      })
  );
});

self.addEventListener('push', function(event) {
  let data = { title: 'Пустой пуш', body: 'Нет данных' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    data = { title: 'Пуш', body: event.data ? event.data.text() : 'Нет данных' };
  }

  const title = data.title || 'Уведомление';
  const options = {
    body: data.body || '',
    icon: 'assets/icon-phone-192.png',
    tag: 'remote-push',
    data: { url: data.url || '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});