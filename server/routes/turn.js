// --- маршруты для получения TURN-серверов Metered

const express = require('express');
const router = express.Router();
const { checkAuthStatus } = require('./session');

// Для безопасности лучше брать из process.env
const METERED_DOMAIN = process.env.METERED_DOMAIN;
const METERED_SECRET = process.env.METERED_SECRET;

if (!METERED_DOMAIN || !METERED_SECRET) {
  console.warn('[server] Metered TURN credentials not set in env!');
}

// отдаём TURN/STUN данные авторизованному пользователю
router.get('/get-turn-credentials', (req, res) => {
  try {
    const s = checkAuthStatus(req, res);
    if (!s) return;

    // формируем ICE-серверы для WebRTC
    const iceServers = [
      { urls: `stun:${METERED_DOMAIN}:3478` },
      {
        urls: `turn:${METERED_DOMAIN}:3478?transport=udp`,
        username: 'username',
        credential: METERED_SECRET
      },
      {
        urls: `turn:${METERED_DOMAIN}:3478?transport=tcp`,
        username: 'username',
        credential: METERED_SECRET
      }
    ];

    res.json({ iceServers });
  } catch (e) {
    console.error('/get-turn-credentials error', e && (e.stack || e));
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
