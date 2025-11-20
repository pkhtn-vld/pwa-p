// --- маршруты для push‑подписок

const express = require('express');
const router = express.Router();
const WebSocket = require('ws');

const state = require('../config/state');
const { checkAuthStatus } = require('./session');
const { subscriptionsByUser } = require('../config/config');
const { persistSubscriptions } = require('../services/dataStore');

// сохраняем web‑push подписку пользователя
router.post('/subscribe', async (req, res) => {
  try {
    const s = checkAuthStatus(req, res);
    if (!s) return;

    const userKey = (s.userKey || '').toString().toLowerCase();
    const body = req.body || {};
    const subscription = body.subscription || body;

    if (!subscription || !subscription.endpoint) {
      console.warn('subscribe: invalid subscription body');
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    if (!Array.isArray(subscriptionsByUser[userKey])) subscriptionsByUser[userKey] = [];
    const existing = subscriptionsByUser[userKey].find(x => x.endpoint === subscription.endpoint);

    if (!existing) {
      subscriptionsByUser[userKey].push(subscription);
      // дождёмся сохранения (чтобы не потерять подписку при рестарте)
      try {
        await persistSubscriptions();
      } catch (err) {
        console.error('persistSubscriptions err', err);
      }
    }

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('subscribe error', e && e.stack || e);
    return res.status(500).json({ error: 'subscribe failed' });
  }
});

// возвращаем, есть ли у текущего пользователя подписка
router.get('/has-subscription', (req, res) => {
  try {
    const s = checkAuthStatus(req, res);
    if (!s) return;

    const userKey = (s.userKey || '').toString().toLowerCase();
    const subs = subscriptionsByUser[userKey] || [];

    // вернём есть ли подписки и их endpoint'ы (без ключей)
    const endpoints = subs
      .filter(x => x && x.endpoint)
      .map(x => x.endpoint);

    return res.json({
      hasSubscription: endpoints.length > 0,
      endpoints
    });
  } catch (e) {
    console.error('has-subscription error', e && e.stack || e);
    return res.status(500).json({ error: 'internal' });
  }
});

// возвращаем клиенту публичный VAPID‑ключ из .env
router.get('/vapidPublicKey', (req, res) => {
  // чтобы избежать рассогласования имен env-переменных
  res.set('Cache-Control', 'no-store');
  res.json({ publicKey: process.env.publicKey || '' });
});

// клиент подтверждает получение push -> сервер шлёт отправителю квитанцию (chat_receipt) через WS
router.post('/push-received', async (req, res) => {
  try {
    const s = checkAuthStatus(req, res);
    if (!s) return;

    const recipient = (s.userKey || '').toString().toLowerCase(); // текущий пользователь — получатель push
    const body = req.body || {};
    const fromRaw = String(body.from || '').toLowerCase();
    const messageTs = body.ts || null;
    const messageId = body.messageId || null;
    const status = body.status || 'delivered'; // по умолчанию delivered

    if (!fromRaw) {
      console.warn('[push-received] missing from in body');
      return res.status(400).json({ error: 'from required' });
    }

    // попытка послать chat_receipt отправителю по WS
    try {
      const senderKey = fromRaw;
      const targets = (state.presenceObj && state.presenceObj.clientsByUser && state.presenceObj.clientsByUser.get(senderKey)) || null;
      let openCount = 0;
      let visibleOpenCount = 0;

      if (targets && targets.size > 0) {
        for (const t of targets) {
          try {
            // if (t.readyState === t.OPEN) {
            if (t.readyState === WebSocket.OPEN) {
              openCount++;
              const isVisible = Boolean(t._meta && t._meta.visible);
              if (isVisible) {
                visibleOpenCount++;
                const payload = { type: 'signal', from: recipient, payload: { type: 'chat_receipt', ts: messageTs, status } };
                t.send(JSON.stringify(payload));
              }
            }
          } catch (e) {
            console.warn('[push-received] failed sending to one socket', e && e.message ? e.message : e);
          }
        }
      }

      // Возвращаем успех в любом случае (если отправитель не в сети — сервер ничего не должен ломать)
      return res.json({ ok: true, sentToOpen: visibleOpenCount > 0 });
    } catch (e) {
      console.error('[push-received] internal send error', e && (e.stack || e));
      return res.status(500).json({ error: 'internal' });
    }
  } catch (e) {
    console.error('[push-received] handler error', e && (e.stack || e));
    return res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
