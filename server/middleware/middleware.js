// middleware и утилиты

const cors = require('cors');
const express = require('express');
const path = require('path');

const state = require('../config/state');

try {
  state.allowUserList = require('../config/allowUsersList');
  if (!Array.isArray(state.allowUserList)) state.allowUserList = [];
} catch (e) {
  state.allowUserList = [];
}

// to dev
// логируем запросы
function requestLogger(req, res, next) {
  try {
    const cookie = req.headers.cookie || '';
    const origin = req.headers.origin || '';
    console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.originalUrl} origin=${origin} cookie=${cookie}`);
    // логируем тело только для методов с телом и в разумных пределах
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      try {
        const b = JSON.stringify(req.body);
        console.log('[REQ BODY]', b.length > 1024 ? b.slice(0, 1024) + ' ...(truncated)' : b);
      } catch (e) {
        console.log('[REQ BODY] <unserializable body>');
      }
    }
  } catch (e) {
    // не ломаем поток запросов из-за логгирования
    console.error('requestLogger error', e && e.stack || e);
  }
  next();
}

// нормализуем имя
function normalizeName(n) {
  return (String(n || '').trim().toLowerCase());
}

// проверяем имя по списку
function isAllowedName(displayName) {
  if (!displayName) return false;
  if (!Array.isArray(state.allowUserList) || state.allowUserList.length === 0) return true; // пустой массив = allow all
  const norm = normalizeName(displayName);
  return state.allowUserList.some(s => normalizeName(s) === norm);
}

// блокируем запрещённые имена
function requireAllowedName(req, res, next) {
  // пытаемся получить displayName из body, query или параметров
  const fromBody = (req.body && req.body.displayName) || (req.body && req.body.userName);
  const fromQuery = req.query && (req.query.displayName || req.query.userName);
  const candidate = fromBody || fromQuery || '';
  if (!isAllowedName(candidate)) {
    console.warn('Blocked attempt with disallowed name:', candidate);
    return res.status(403).json({ error: 'User not allowed' });
  }
  next();
}

// настройка CORS
function corsMiddleware() {
  const corsOrigin = process.env.ORIGIN || true;
  return cors({
    origin: corsOrigin, // какой источник разрешён (строка из .env или true = все)
    credentials: true,  // разрешаем отправку куки/авторизационных заголовков
  });
}

// подключаем все middleware
function setupMiddleware(app) {
  app.set('trust proxy', 1);  // доверяем заголовкам X-Forwarded-*
  app.use(corsMiddleware());
  app.use(express.json({ limit: '128kb' }));  // парсим JSON‑тело запросов, ограничиваем размер до 128 килобайт
  app.use(express.static(path.join(__dirname, '..', '..', 'dist'))); // раздаём статические файлы фронтенда из папки dist/
  app.use(requestLogger); // to dev
}


module.exports = {
  requireAllowedName,
  setupMiddleware,
};
