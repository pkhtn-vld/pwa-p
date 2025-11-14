const WebSocket = require('ws');

function attachPresence(httpServer, opts = {}) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const clientsByUser = new Map();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // подробное логирование WebSocket handshake
    try {
      console.log(`[WS CONNECT] ${new Date().toISOString()} path=${req.url} origin=${req.headers.origin || ''} cookie=${req.headers.cookie || ''} remote=${req.socket && req.socket.remoteAddress}`);
    } catch (e) { }

    let sessionId = null;

    // если нет — попробуем взять из заголовка cookie (сервер видит HttpOnly куки)
    if (!sessionId && req.headers && req.headers.cookie) {
      const cookie = req.headers.cookie.split(';').map(s => s.trim());
      const m = cookie.find(s => s.indexOf('pwa_session=') === 0);
      if (m) sessionId = m.split('=')[1];
    }

    // логируем найденный sessionId (может быть null)
    try { console.log('[WS] resolved sessionId=', sessionId); } catch (e) { }

    // проверка Origin: если указана опция expectedOrigin, блокируем другие
    if (opts.expectedOrigin && req.headers && req.headers.origin) {
      if (req.headers.origin !== opts.expectedOrigin) {
        ws.close(1008, 'Origin not allowed');
        return;
      }
    }

    let userKey = null;
    if (sessionId && typeof opts.getSessionById === 'function') {
      const s = opts.getSessionById(sessionId);
      if (s) userKey = s.userKey;
    }

    if (!userKey) {
      try { ws.close(1008, 'Unauthorized'); } catch (e) { try { ws.terminate(); } catch (e2) { } }
      return;
    }

    ws._meta = { userKey, sessionId };

    if (userKey) {
      let set = clientsByUser.get(userKey);
      if (!set) { set = new Set(); clientsByUser.set(userKey, set); }
      set.add(ws);
      broadcastPresence();
    }

    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      // защита от слишком большого пакета (пример 64KB):
      if (typeof raw === 'string' && raw.length > 64 * 1024) {
        try { ws.terminate(); } catch (e) { }
        return;
      }

      if (msg.type === 'signal' && msg.to) {

        // валидация сообщений
        if (msg.payload && msg.payload.type === 'chat_message') {
          const text = String(msg.payload.text || '');
          if (text.length === 0 || text.length > 2000) {
            // можно отправить клиенту ошибку или просто игнорировать
            return;
          }
          // нормализуем: обрезаем, удаляем управляющие символы и т.п.
          msg.payload.text = text.slice(0, 2000);
        }

        const targets = clientsByUser.get(msg.to);
        let delivered = false;
        if (targets) {
          delivered = true;
          for (const t of targets) {
            try {
              if (t.readyState === WebSocket.OPEN) t.send(JSON.stringify({ type: 'signal', from: ws._meta.userKey, payload: msg.payload || null }));
            } catch (e) { /* ignore */ }
          }
        }
        if (opts.onSignal) {
          try { opts.onSignal(ws._meta.userKey, msg.to, msg.payload || null, delivered); } catch (e) { }
        }
      }
      else if (msg.type === 'heartbeat') {
        ws.isAlive = true;
      } else if (msg.type === 'list') {
        const online = Array.from(clientsByUser.keys());
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'list', online })); } catch (e) {}
      }
    });

    ws.on('close', () => {
      if (ws._meta.userKey) {
        const set = clientsByUser.get(ws._meta.userKey);
        if (set) {
          set.delete(ws);
          if (set.size === 0) clientsByUser.delete(ws._meta.userKey);
        }
        broadcastPresence();
      }
    });

    function broadcastPresence() {
      const online = Array.from(clientsByUser.keys());
      const payload = JSON.stringify({ type: 'presence', online });
      for (const set of clientsByUser.values()) {
        for (const c of set) {
          try { if (c.readyState === WebSocket.OPEN) c.send(payload); } catch (e) { /* ignore */ }
        }
      }
    }
  });

  // ping/pong to detect dead connections
  const interval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(() => {}); } catch (e) {}
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));
  return { wss, clientsByUser };
}

module.exports = { attachPresence };
