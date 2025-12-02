const WebSocket = require('ws');

function attachPresence(httpServer, opts = {}) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const clientsByUser = new Map();

  wss.on('connection', (ws, req) => {

    // to dev
    // подробное логирование WebSocket handshake
    // try {
    //   console.log(`[WS CONNECT] ${new Date().toISOString()} path=${req.url} origin=${req.headers.origin || ''} cookie=${req.headers.cookie || ''} remote=${req.socket && req.socket.remoteAddress}`);
    // } catch (e) { }

    let sessionId = null;

    // если нет — попробуем взять из заголовка cookie (сервер видит HttpOnly куки)
    if (!sessionId && req.headers && req.headers.cookie) {
      const cookie = req.headers.cookie.split(';').map(s => s.trim());
      const m = cookie.find(s => s.indexOf('pwa_session=') === 0);
      if (m) sessionId = m.split('=')[1];
    }

    // to dev
    // логируем найденный sessionId (может быть null)
    // try { console.log('[WS] resolved sessionId=', sessionId); } catch (e) { }

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
      if (s && s.userKey) userKey = String(s.userKey).toLowerCase();
    }

    if (!userKey) {
      try { ws.close(1008, 'Unauthorized'); } catch (e) { try { ws.terminate(); } catch (e2) { } }
      return;
    }

    ws._meta = { userKey, sessionId, visible: true };

    if (userKey) {
      let set = clientsByUser.get(userKey);
      if (!set) { set = new Set(); clientsByUser.set(userKey, set); }
      set.add(ws);
      broadcastPresence();
    }

    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (raw) => {
      // raw может быть Buffer или string
      let text;
      if (Buffer.isBuffer(raw)) {
        // лимит в байтах — 64KB
        if (raw.length > 64 * 1024) {
          try { ws.terminate(); } catch (e) { }
          return;
        }
        text = raw.toString('utf8');
      } else {
        if (typeof raw === 'string') {
          if (raw.length > 64 * 1024) {
            try { ws.terminate(); } catch (e) { }
            return;
          }
          text = raw;
        } else {
          // непонятный тип — игнорируем
          return;
        }
      }

      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }

      if (msg && msg.type === 'visibility') {
        // ожидаем { type: 'visibility', visible: true|false }
        try {
          ws._meta.visible = !!msg.visible;
          // при изменении видимости можно опционально broadcastPresence();
        } catch (e) { /* ignore */ }
        return;
      }

      if (msg.type === 'signal' && msg.to) {

        // валидация сообщений
        if (msg.payload && msg.payload.type === 'chat_message') {
          const textmsg = String(msg.payload.text || '');
          if (textmsg.length === 0 || textmsg.length > 2000) {
            return;
          }
          // нормализуем: обрезаем, удаляем управляющие символы и т.п.
          msg.payload.text = textmsg.slice(0, 2000);
        }

        // нормализуем ключ получателя
        const toKey = String(msg.to || '').toLowerCase();
        const targets = clientsByUser.get(toKey);
        let delivered = false;
        let openCount = 0;
        let visibleOpenCount = 0;

        if (targets && targets.size > 0) {
          for (const t of targets) {
            try {
              if (t.readyState === WebSocket.OPEN) {
                openCount++;
                // учитываем видимость клиента
                const isVisible = Boolean(t._meta && t._meta.visible);
                if (isVisible) {
                  visibleOpenCount++;
                  t.send(JSON.stringify({ type: 'signal', from: ws._meta.userKey, payload: msg.payload || null }));
                }
              }
            } catch (e) {
              console.warn('Failed to send to a socket for', toKey, e && e.message);
            }
          }
          if (visibleOpenCount > 0) delivered = true;
        }

        // подробный лог о доставке
        console.log(`// ws: signal from=${ws._meta.userKey} to=${toKey} type=${msg.payload && msg.payload.type} delivered=${delivered} openCount=${openCount} visibleOpenCount=${visibleOpenCount}`);

        // отправка серверного лога в отдельный endpoint /debug/log не обязательна,
        // но может быть полезной для централизованного сбора — посылаем асинхронно (без await)
        try {
          const serverLog = {
            ts: new Date().toISOString(),
            src: 'presenceService',
            event: 'signal',
            from: ws._meta.userKey,
            to: toKey,
            type: msg.payload && msg.payload.type,
            callId: msg.payload && msg.payload.callId,
            delivered,
            openCount,
            visibleOpenCount
          };
          try {
            fetch('http://127.0.0.1:' + (opts && opts.debugPort ? opts.debugPort : (process.env.DEBUG_PORT || '3000')) + '/debug/log', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(serverLog)
            }).catch(() => {/* ignore */ });
          } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }


        if (opts.onSignal) {
          try { opts.onSignal(ws._meta.userKey, toKey, msg.payload || null, delivered); } catch (e) { /* ignore */ }
        }
      }
      else if (msg.type === 'heartbeat') {
        ws.isAlive = true;
      } else if (msg.type === 'list') {
        const online = Array.from(clientsByUser.keys());
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'list', online })); } catch (e) { }
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
      try { ws.ping(() => { }); } catch (e) { }
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));
  return { wss, clientsByUser };
}

module.exports = { attachPresence };
