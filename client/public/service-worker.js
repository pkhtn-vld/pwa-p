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
    // если клиентов нет — откроем новое окно/страницу приложения
    if (clients.openWindow) {
      if (from) {
        // вы можете прикрепить query param чтобы сразу открыть чат (если реализовано)
        return clients.openWindow('/');
      }
      return clients.openWindow('/');
    }
  }));
});

// saveToIDB(msg)
// сохраняет объект msg в IndexedDB базы 'pwa-chat', store 'messages'.
// формат записи ожидаемый клиентом:
// { from, to, text, encrypted: true|false, ts, meta: {...}, read: false }
// возвращает Promise<boolean> — true если записано, false при ошибке.
function saveToIDB(msg) {
  return new Promise((resolve) => {
    try {
      const rq = indexedDB.open('pwa-chat', 1);
      rq.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
      };
      rq.onsuccess = function (e) {
        const db = e.target.result;
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        store.add(msg);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); resolve(false); };
      };
      rq.onerror = function () { resolve(false); };
    } catch (e) {
      console.warn('[SW] saveToIDB exception', e);
      resolve(false);
    }
  });
}

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data && typeof event.data.json === 'function' ? event.data.json() : {};
  } catch (e) {
    try { data = { body: event.data && event.data.text ? event.data.text() : '' }; } catch (ee) { data = {}; }
  }

  event.waitUntil((async () => {

    // Сохраняем payload в IndexedDB *всегда* — чтобы клиент мог потом получить историю и расшифровать.
    // payload формат в сервере: { title, body, data: { from, payload } }
    try {
      const from = (data.data && data.data.from) || null;
      const payload = (data.data && data.data.payload) || null;
      const msgToSave = {
        from,
        to: null,
        text: payload && payload.text ? payload.text : (data.body || ''),
        encrypted: !!(payload && payload.encrypted),
        ts: Date.now(),
        meta: { via: 'push' },
        read: false,
      };
      const ok = await saveToIDB(msgToSave);
      console.log('[SW] saveToIDB for push returned', !!ok, 'from=', from);
    } catch (e) {
      console.warn('[SW] failed to save push payload to IDB', e && (e.stack || e));
    }
    
    try {
      // Получим все открытые окна/вкладки PWA (включая неконтролируемые)
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

      // Отправим push-данные всем клиентам (они обновят UI или покажут in-app toast)
      for (const c of allClients) {
        try { c.postMessage({ type: 'push', data }); } catch (e) { /* ignore */ }
      }

      // Проверим, есть ли видимый клиент (visibilityState === 'visible')
      let anyVisible = false;
      for (const c of allClients) {
        try {
          if (c.visibilityState === 'visible') { anyVisible = true; break; }
        } catch (e) { /* ignore */ }
      }

      // Если есть видимый клиент — НЕ показываем системную нотификацию (in-app toast достаточно)
      if (anyVisible) return;

      // В противном случае (нет видимых окон) — показываем нативную нотификацию
      const title = data.title || 'Новое сообщение';
      const options = {
        body: '',
        data: data.data || {},
        tag: data.tag || ('chat-' + (data.data && data.data.from || Date.now())),
        renotify: true,
        icon: '/assets/icon-phone-192.png'
      };
      await self.registration.showNotification(title, options);
    } catch (e) {
      console.error('[SW] push handler fatal error', e && (e.stack || e));
    }
  })());
});
