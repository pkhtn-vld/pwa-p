// --- активность пользователя

import { updateOnlineList, setPresenceClient, handleIncomingMessage, showInAppToast } from "./userList.js";

let pc = null;

// создаёт клиента, подключает его и синхронизирует с видимостью страницы
export async function ensurePresenceClient() {
  if (pc) return pc;
  pc = createPresenceClient();
  // Попытка подключиться немедленно, если уже есть сессия
  await pc.connectWhenAuth();

  try {
    // отправим текущее состояние (будет буферизовано, если ws ещё не открыт)
    sendVisibilityState(pc, document.visibilityState === 'visible');

    // слушаем изменения видимости
    document.addEventListener('visibilitychange', () => {
      const isVisible = document.visibilityState === 'visible';
      sendVisibilityState(pc, isVisible);
    }, { passive: true });

    // pagehide — попытка отправить перед закрытием/сворачиванием
    window.addEventListener('pagehide', () => {
      try { sendVisibilityState(pc, false); } catch (e) { }
    });

    // опционально: beforeunload (меньше шансов успеха, но лучше попытаться)
    window.addEventListener('beforeunload', () => {
      try { sendVisibilityState(pc, false); } catch (e) { }
    });
  } catch (e) { console.warn('visibility hook failed', e); }

  setPresenceClient(pc);
  attachPresenceListeners(pc);
  return pc;
}

// создаёт WebSocket‑клиент для отслеживания онлайн‑статуса и сигналов
function createPresenceClient(opts = {}) {
  const baseUrl = opts.url || `${(location.protocol === 'https:' ? 'wss' : 'ws')}://${location.host}/ws`;
  let ws = null;
  let connected = false;
  const listeners = { presence: [], signal: [], open: [], close: [] };
  let hbInterval = null;
  let pendingQueue = [];       // очередь сообщений, пока не открыт WS
  let reconnecting = false;

  // запускает таймер, который каждые 20 секунд шлёт heartbeat на сервер
  function heartbeatTimer() {
    if (hbInterval) clearInterval(hbInterval);
    hbInterval = setInterval(() => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
      } catch (e) { /* ignore */ }
    }, 20000);
  }

  // отправляет накопленные сообщения из очереди, когда соединение открыто
  function flushQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (pendingQueue.length > 0) {
      const msg = pendingQueue.shift();
      try { ws.send(JSON.stringify(msg)); } catch (e) { console.warn('flushQueue send failed', e); break; }
    }
  }

  // устанавливает WebSocket‑соединение и настраивает обработчики событий
  function connect() {
    // если уже подключаемся/подключены — ничего не делаем
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(baseUrl);
    } catch (e) {
      console.error('WebSocket ctor failed', e);
      return;
    }

    ws.addEventListener('open', () => {
      connected = true;
      reconnecting = false;
      listeners.open.forEach(fn => { try { fn(); } catch (e) { } });
      // запросим список онлайн
      try { ws.send(JSON.stringify({ type: 'list' })); } catch (e) { }
      heartbeatTimer();
      flushQueue();
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg && msg.type === 'presence') {
        listeners.presence.forEach(fn => { try { fn(msg.online || []); } catch (e) { } });
      } else if (msg && msg.type === 'signal') {
        listeners.signal.forEach(fn => { try { fn(msg.from, msg.payload); } catch (e) { } });
      } else if (msg && msg.type === 'list') {
        listeners.presence.forEach(fn => { try { fn(msg.online || []); } catch (e) { } });
      }
    });

    ws.addEventListener('close', () => {
      connected = false;
      if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
      listeners.close.forEach(fn => { try { fn(); } catch (e) { } });

      // логика переподключения
      if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => { reconnecting = false; connect(); }, 1500 + Math.random() * 1000);
      }
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch (e) { }
      if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
    });
  }

  // проверяет /session — если аутентифицировано, подключается
  async function connectWhenAuth() {
    try {
      const r = await fetch('/session', { credentials: 'include' });
      if (!r.ok) return false;

      connect();
      return true;
    } catch (err) {
      console.error('connectWhenAuth: ошибка проверки сессии', err);
      return false;
    }
  }

  // Подписка на события
  function on(evt, fn) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(fn);
    return () => { listeners[evt] = listeners[evt].filter(x => x !== fn); };
  }

  // отправляет произвольное сообщение или кладёт его в очередь, если соединение не готово
  function sendRaw(msg) {
    try {
      if (!msg || typeof msg !== 'object') return false;
      // защита от слишком больших сообщений
      const s = JSON.stringify(msg);
      if (s.length > 64 * 1024) { console.warn('sendRaw: message too large'); return false; }

      // ограничение буфера
      const MAX_PENDING = 200;
      if (pendingQueue.length >= MAX_PENDING) {
        console.warn('pendingQueue full, dropping raw message');
        return false;
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(s); return true; } catch (e) { console.warn('sendRaw send failed, queueing', e); pendingQueue.push(msg); return false; }
      }

      pendingQueue.push(msg);
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
      return false;
    } catch (e) {
      console.warn('sendRaw failed', e);
      return false;
    }
  }

  // сообщает серверу, видна ли вкладка пользователя
  function sendVisibility(visible) {
    return sendRaw({ type: 'visibility', visible: !!visible });
  }

  // sendSignal: валидация + отправка (или буферизация)
  function sendSignal(to, payload) {
    // базовая валидация
    try {
      if (!to || (typeof to !== 'string' && typeof to !== 'number')) {
        throw new Error('invalid "to"');
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('invalid payload');
      }

      // ограничение типов: разрешаем только определённые типы сообщений
      const allowedTypes = ['chat_message', 'chat_receipt'];
      if (!payload.type || allowedTypes.indexOf(payload.type) === -1) {
        throw new Error('unsupported payload.type');
      }

      // валидируем chat_message текст
      if (payload.type === 'chat_message') {
        let text = String(payload.text || '');

        // удалим управляющие символы кроме пробелов/переносов, обрежем до 2000
        text = text.replace(/[\x00-\x1F\x7F]/g, '');
        if (text.length === 0 || text.length > 2000) {
          throw new Error('invalid text length');
        }

        payload.text = text.slice(0, 2000);
      }

      // валидация chat_receipt: ожидаем ts и status
      if (payload.type === 'chat_receipt') {
        if (!('ts' in payload) || isNaN(Number(payload.ts))) {
          throw new Error('chat_receipt requires numeric ts');
        }
        const status = String(payload.status || '');
        const allowedStatus = ['delivered', 'read', 'failed'];
        if (allowedStatus.indexOf(status) === -1) {
          throw new Error('chat_receipt: unsupported status');
        }
      }

      const msg = { type: 'signal', to: String(to), payload };

      // ограничение размера буфера (защита от OOM при долгом офлайне)
      const MAX_PENDING = 200;
      if (pendingQueue.length >= MAX_PENDING) {
        console.warn('pendingQueue full, dropping message');
        return false;
      }

      // если соединение открыто — отправим сразу
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
          return true;
        }
        catch (e) {
          console.warn('sendSignal WS send failed, queueing', e);
          pendingQueue.push(msg);
          return false;
        }
      }

      // если соединение не открыто — буферизуем и попытаемся подключиться
      pendingQueue.push(msg);

      // если ws не создали — попробуем подключиться
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
      return false;
    } catch (e) {
      console.warn('sendSignal validation failed', e && e.message ? e.message : e);
      return false;
    }
  }

  // публичный API
  return {
    connectWhenAuth,
    connect,
    sendSignal,
    sendRaw,
    sendVisibility,
    on,
    isConnected: () => connected,
    raw: () => ws
  };
}

// универсально отправляет состояние видимости
function sendVisibilityState(pc, visible) {
  try {
    if (!pc) return;
    if (typeof pc.sendVisibility === 'function') {
      pc.sendVisibility(visible);
      return;
    }
    // fallback: если нет sendVisibility — попробуем sendRaw or raw()
    if (typeof pc.sendRaw === 'function') {
      pc.sendRaw({ type: 'visibility', visible: !!visible });
      return;
    }
    const ws = (pc.raw && pc.raw()) || null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'visibility', visible: !!visible }));
    }
  } catch (e) { console.warn('sendVisibilityState failed', e); }
}

// навешивает обработчики на события presence и signal, обновляет список онлайн и сообщения
function attachPresenceListeners(p) {
  if (!p) return;
  p.on('presence', (online) => {
    console.log('online list', online);
    updateOnlineList(online);
  });
  p.on('signal', async (from, payload) => {
    try {
      console.log('[presence.signal] from=', from, 'payload=', payload);

      // Обрабатываем и chat_message, и chat_receipt через один обработчик,
      // который делегирует детали в handleIncomingMessage.
      if (payload && (payload.type === 'chat_message' || payload.type === 'chat_receipt')) {
        try {
          const handled = await handleIncomingMessage(from, payload);
          // Показываем in-app toast только если это chat_message и не отрисовано в открытом чате
          if (!handled && payload.type === 'chat_message') {
            showInAppToast(`Новое сообщение от ${from.charAt(0).toUpperCase() + from.slice(1)}`, { from });
          }
        } catch (e) {
          console.error('[presence.signal] handleIncomingMessage threw', e);
        }
        return;
      }

      // другие типы сигналов — логируем
      console.log('signal from', from, payload);
    } catch (e) {
      console.error('signal handler error', e);
    }
  });
  // p.on('open'...)
}
