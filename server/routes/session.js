// --- работа с сессиями и пользователями

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { persistSessions } = require('../services/dataStore');
const state = require('../config/state');

// создаём новую сессию
function createSession({ userKey, displayName }) {
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const ttl = 1000 * 60 * 60; // 1 час
  state.sessions[sessionId] = { userKey, displayName, createdAt: now, expiresAt: now + ttl };
  // не ждём
  persistSessions().catch(err => console.error('persistSessions err', err));
  return { sessionId, ttl };
}

// возвращаем сессию по ID
function getSession(sessionId) {
  const s = state.sessions[sessionId];
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    delete state.sessions[sessionId];
    persistSessions().catch(err => console.error('persistSessions err', err));
    return null;
  }
  return s;
}

// проверка cookie и возврат ответа
function checkAuthStatus(req, res) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('pwa_session='));
  if (!match) {
    res.status(401).json({ authenticated: false, error: 'Not authenticated' });
    return null;
  }
  const sessionId = match.split('=')[1];
  const s = getSession(sessionId);
  if (!s) {
    res.status(401).json({ authenticated: false, error: 'Not authenticated' });
    return null;
  }
  return s;
}

// проверяем cookie и возвращаем статус авторизации
router.get('/session', (req, res) => {
  const s = checkAuthStatus(req, res);
  if (!s) return;

  res.json({ authenticated: true, userName: s.displayName || s.userKey || '' });
});

// возвращаем список всех зарегистрированных пользователей
router.get('/users', (req, res) => {
  const s = checkAuthStatus(req, res);
  if (!s) return;

  const currentUserKey = (s.userKey || '').toString().toLowerCase();

  // формируем set онлайн userKey'ов
  const now = Date.now();
  const onlineSet = new Set();
  Object.values(state.sessions).forEach(sess => {
    if (sess && sess.expiresAt && sess.expiresAt > now && sess.userKey) {
      onlineSet.add(String(sess.userKey).toLowerCase());
    }
  });

  const users = Object.keys(state.savedCredentials)
    .filter(userKey => userKey.toLowerCase() !== currentUserKey) // исключаем себя
    .map(userKey => {
      const arr = state.savedCredentials[userKey] || [];
      const displayName = (arr[0] && arr[0].displayName) || userKey;
      return { userKey, displayName, online: onlineSet.has(String(userKey).toLowerCase()) };
    });

  res.json({ users });
});

module.exports = {
  createSession,
  checkAuthStatus,
  getSession,

  router
};
