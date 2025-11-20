// --- маршруты для управления публичными ключами пользователей

const express = require('express');
const router = express.Router();

const state = require('../config/state');
const { checkAuthStatus } = require('./session');
const { persistCredentials } = require('../services/dataStore')

// сохраняем публичный ключ пользователя (sodium)
router.post('/upload-pubkey', async (req, res) => {
  try {
    const s = checkAuthStatus(req, res);
    if (!s) return;

    const userKey = (s.userKey || '').toString().toLowerCase();
    const body = req.body || {};
    const publicKey = body.publicKey || null;
    if (!publicKey) return res.status(400).json({ error: 'publicKey required' });

    // Убедимся, что state.savedCredentials[userKey] существует как массив
    if (!Array.isArray(state.savedCredentials[userKey])) state.savedCredentials[userKey] = state.savedCredentials[userKey] || [];

    // Если есть хотя бы одна запись учетных данных, прикрепим sodiumPublicKeyBase64 к первой; в противном случае создаем.
    if (state.savedCredentials[userKey].length === 0) {
      state.savedCredentials[userKey].push({
        id: 'sodium-pub',
        publicKeyBase64: '',
        counter: 0,
        transports: [],
        createdAt: Date.now(),
        displayName: s.displayName || userKey,
        sodiumPublicKeyBase64: publicKey
      });
    } else {
      state.savedCredentials[userKey][0].sodiumPublicKeyBase64 = publicKey;
    }

    // сохранить на диск
    await persistCredentials();
    console.log('[server] uploaded sodium pubkey for', userKey);
    return res.json({ ok: true });
  } catch (e) {
    console.error('upload-pubkey error', e && (e.stack || e));
    return res.status(500).json({ error: 'internal' });
  }
});

// отдаём публичный ключ по имени пользователя
router.get('/pubkey', (req, res) => {
  try {
    const q = String(req.query.user || '').toLowerCase();
    if (!q) return res.status(400).json({ error: 'user query param required' });
    const arr = state.savedCredentials[q];
    if (!arr || arr.length === 0) return res.status(404).json({ error: 'not found' });

    // предпочитать sodiumPublicKeyBase64 при первом вводе учетных данных
    const pk = arr[0].sodiumPublicKeyBase64 || null;
    if (!pk) return res.status(404).json({ error: 'no pubkey' });
    res.json({ publicKey: pk });
  } catch (e) {
    console.error('/pubkey error', e && (e.stack || e));
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
