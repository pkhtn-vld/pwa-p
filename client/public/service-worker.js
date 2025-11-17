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

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // пропускаем все API/auth запросы
  if (url.pathname.startsWith('/auth') || url.pathname.startsWith('/api') || event.request.method !== 'GET') {
    return event.respondWith(fetch(event.request));
  }

  // навигация: network first
  if (event.request.mode === 'navigate') {
    return event.respondWith(
      fetch(event.request).catch(() => caches.match('/offline.html'))
    );
  }
  
  // для статических ресурсов: кэш-первым
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});


self.addEventListener('notificationclick', function (event) {
  // закрываем уведомление после клика
  event.notification.close();

  // получаем идентификатор отправителя из данных уведомления (если есть)
  const from = (event.notification.data && event.notification.data.from) || null;

  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    // если есть открытое окно приложения — переводим его в фокус
    for (const client of clientList) {
      if (client.url && 'focus' in client) {
        client.focus();
        // отправляем сообщение в клиент, чтобы открыть чат с нужным пользователем
        if (from) client.postMessage({ type: 'open_chat', from });
        return;
      }
    }
    // если открытых окон нет — открываем новое окно приложения
    if (clients.openWindow) {
      return clients.openWindow('/');
    }
  }));
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data && event.data.json ? event.data.json() : {};
  } catch (e) {
    try { data = { body: event.data && event.data.text ? event.data.text() : '' }; } catch (ee) { data = {}; }
  }

  event.waitUntil((async () => {
    // Получим все открытые окна/вкладки PWA
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Если есть открытые клиенты — отправим им push-данные (они решат, показывать ли UI/note)
    if (allClients && allClients.length > 0) {
      // отметим, есть видимые клиенты
      let anyVisible = false;
      for (const c of allClients) {
        try {
          // WindowClient имеет visibilityState: 'visible'|'hidden'
          if (c.visibilityState === 'visible') anyVisible = true;
        } catch (e) { }
        // отправляем сообщение в клиент — пусть клиент решает, показывать in-app toast или обновлять чат
        try { c.postMessage({ type: 'push', data }); } catch (e) { }
      }

      // Если хотя бы одно окно видно (пользователь взаимодействует) — НЕ показываем нативную нотификацию
      if (anyVisible) return;
      // иначе — все окна есть, но скрыты/минімізированы — продолжаем и покажем notification
    }

    // Если нет открытых клиентов или все скрыты — показываем нотификацию
    const title = data.title || 'Новое сообщение';
    const options = {
      body: data.body || '',
      data: data.data || {},
      tag: data.tag || ('chat-' + (data.data && data.data.from || Date.now())),
      renotify: true,
      icon: '/assets/icon-phone-192.png'
    };
    await self.registration.showNotification(title, options);
  })());
});
