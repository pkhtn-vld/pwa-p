// to dev

const express = require('express');
const router = express.Router();

const { subscriptionsByUser } = require('../config/config');

// принимает лог от клиента и выводит его на сервер
router.post('/debug-log', (req, res) => {
  console.log('=== DEBUG LOG FROM CLIENT ===');
  console.log(JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// возвращает подписки (все или конкретного пользователя)
router.get('/debug-subs', (req, res) => {
  const q = String(req.query.user || '').toLowerCase();
  if (!q) {
    return res.json({ all: Object.keys(subscriptionsByUser) });
  }
  res.json({ user: q, subs: subscriptionsByUser[q] || [] });
});

module.exports = router;
