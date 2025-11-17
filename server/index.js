require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const http = require('http');
const { attachPresence } = require('./presence');
const { createClient: createWebdavClient } = require('webdav');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoUint8Array } = require('@simplewebauthn/server/helpers');

const app = express();
const port = process.env.PORT || 3000;

// Настройки из env с fallback на localhost
const RP_ID = process.env.RP_ID || 'localhost';
const EXPECTED_ORIGIN = process.env.ORIGIN || `http://localhost:${port}`;

// webdav config
const WEBDAV_BASE = process.env.WEBDAV_BASE || 'https://webdav.cloud.mail.ru';
const WEBDAV_USER = process.env.WEBDAV_USER || '';
const WEBDAV_PASS = process.env.WEBDAV_PASS || '';

let webdavClient = null;
if (WEBDAV_USER && WEBDAV_PASS) {
  webdavClient = createWebdavClient(WEBDAV_BASE, { username: WEBDAV_USER, password: WEBDAV_PASS });
}

// --- CORS
const corsOrigin = process.env.ORIGIN || true;
app.set('trust proxy', 1);
app.use(cors({
  origin: corsOrigin,
  credentials: true
}));
app.use(express.json({ limit: '128kb' }));
// app.use(express.static(path.join(__dirname, '../client')));

// раздаём собранный фронтенд из dist/
app.use(express.static(path.join(__dirname, '../dist')));

// подробные логи всех входящих запросов
function requestLogger(req, res, next) {
  try {
    const cookie = req.headers.cookie || '';
    const origin = req.headers.origin || '';
    console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.originalUrl} origin=${origin} cookie=${cookie}`);
    // логируем тело только для методов с телом и в разумных пределах
    if (['POST','PUT','PATCH'].includes(req.method) && req.body) {
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
app.use(requestLogger);


// --- VAPID ---
const VAPID_PUBLIC = process.env.publicKey;
const VAPID_PRIVATE = process.env.privateKey;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:ex@mail.com', VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('VAPID keys not provided — push notifications disabled or may fail.');
}

// allow list
let allowUserList = [];
try {
  allowUserList = require('./allowUsersList');
  if (!Array.isArray(allowUserList)) allowUserList = [];
} catch (e) {
  allowUserList = [];
}
// helper: нормализация и проверка
function normalizeName(n) {
  return (String(n || '').trim().toLowerCase());
}
function isAllowedName(displayName) {
  if (!displayName) return false;
  if (!Array.isArray(allowUserList) || allowUserList.length === 0) return true; // пустой массив = allow all
  const norm = normalizeName(displayName);
  return allowUserList.some(s => normalizeName(s) === norm);
}

// middleware для express: принимает имя из query.userName или body.displayName
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

// --- Работа с JSON
const DATA_DIR = path.join(__dirname, 'data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

// Функция сохранения подписок
async function persistSubscriptions() {
  try {
    await saveJSON(SUBS_FILE, subscriptionsByUser);
    if (webdavClient) {
      await uploadToWebdav(SUBS_FILE, '/pwa/subscriptions.json');
    }
  } catch (e) {
    console.error('persistSubscriptions error', e && e.message);
  }
}

async function ensureRemoteDir(remoteDir) {
  if (!webdavClient) return false;
  try {
    await webdavClient.stat(remoteDir);
    return true;
  } catch (err) {
    // если не найден — создаём (createDirectory рекурсивно создаст если поддерживается)
    try {
      await webdavClient.createDirectory(remoteDir);
      return true;
    } catch (e) {
      console.warn('WebDAV: createDirectory failed for', remoteDir, e && e.message);
      return false;
    }
  }
}

async function uploadToWebdav(localPath, remotePath) {
  if (!webdavClient) return;
  try {
    // постфикс: remotePath = '/pwa/credentials.json' -> dir = '/pwa'
    const dir = path.posix.dirname(remotePath);
    // попробуем убедиться, что папка есть
    await ensureRemoteDir(dir);

    const content = await fsp.readFile(localPath);
    await webdavClient.putFileContents(remotePath, content, { overwrite: true });
    console.log('WebDAV: uploaded', remotePath);
  } catch (e) {
    // если 409 — попробуем создать директорию и повторить
    const msg = e && e.message ? e.message : String(e);
    if (msg.includes('409') || msg.toLowerCase().includes('conflict')) {
      try {
        const dir = path.posix.dirname(remotePath);
        await ensureRemoteDir(dir);
        const content = await fsp.readFile(localPath);
        await webdavClient.putFileContents(remotePath, content, { overwrite: true });
        console.log('WebDAV: uploaded after mkdir', remotePath);
        return;
      } catch (ee) {
        console.error('WebDAV upload retry failed', remotePath, ee && ee.message);
      }
    }
    console.error('WebDAV upload error', remotePath, msg);
  }
}


async function downloadFromWebdavIfMissing(localPath, remotePath) {
  if (!webdavClient) return false;
  try {
    const data = await webdavClient.getFileContents(remotePath);
    if (data) {
      await fsp.writeFile(localPath, data);
      console.log('WebDAV: restored', remotePath, '->', localPath);
      return true;
    }
  } catch (e) {
    console.warn('WebDAV download failed for', remotePath, e && e.message);
  }
  return false;
}

async function ensureDataFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(CRED_FILE);
  } catch (e) {
    await saveJSON(CRED_FILE, {});
  }
  try {
    await fsp.access(SESS_FILE);
  } catch (e) {
    await saveJSON(SESS_FILE, {});
  }
   try {
    await fsp.access(SUBS_FILE);
  } catch (e) {
    await saveJSON(SUBS_FILE, {});
  }
}

async function loadJSON(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw || '{}');
}

async function saveJSON(file, obj) {
  const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

let savedCredentials = {}; // { userName: [ { id, publicKeyBase64, counter, transports, createdAt } ] }
let sessions = {};         // { sessionId: { userName, createdAt, expiresAt } }

async function persistCredentials() {
  await saveJSON(CRED_FILE, savedCredentials);
  if (webdavClient) {
    // загрузим в /pwa/credentials.json (пусть будет папка pwa)
    await uploadToWebdav(CRED_FILE, '/pwa/credentials.json');
  }
}
async function persistSessions() {
  await saveJSON(SESS_FILE, sessions);
  if (webdavClient) {
    await uploadToWebdav(SESS_FILE, '/pwa/sessions.json');
  }
}

function createSession({ userKey, displayName }) {
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const ttl = 1000 * 60 * 60; // 1 час
  sessions[sessionId] = { userKey, displayName, createdAt: now, expiresAt: now + ttl };
  // не ждём
  persistSessions().catch(err => console.error('persistSessions err', err));
  return { sessionId, ttl };
}

function getSession(sessionId) {
  const s = sessions[sessionId];
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    delete sessions[sessionId];
    persistSessions().catch(err => console.error('persistSessions err', err));
    return null;
  }
  return s;
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  Object.keys(sessions).forEach(k => {
    if (sessions[k].expiresAt < now) {
      delete sessions[k];
      changed = true;
    }
  });
  if (changed) persistSessions().catch(() => {});
}, 1000 * 60 * 10);

// Храним подписки по userKey: { [userKey]: [ subscription, ... ] }
const subscriptionsByUser = {};
app.post('/subscribe', async (req, res) => {
  try {
    // проверяем сессию (как в /users)
    const cookie = req.headers.cookie || '';
    const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('pwa_session='));
    let sessionId = match ? match.split('=')[1] : null;
    let s = sessionId ? getSession(sessionId) : null;

    if (!s) {
      console.warn('subscribe: Not authenticated (no valid session) — reject');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userKey = (s.userKey || '').toString().toLowerCase();
    const body = req.body || {};
    const subscription = body.subscription || body;

    console.log('POST /subscribe resolved userKey=', userKey, 'subscription present=', !!subscription && !!subscription.endpoint);

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

    console.log('Subscription saved for', userKey, 'totalSubs=', subscriptionsByUser[userKey].length);
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('subscribe error', e && e.stack || e);
    return res.status(500).json({ error: 'subscribe failed' });
  }
});

// Триггер отправки пуша фиксированного шаблона 
// to dev
app.post('/send', async (req, res) => {
  const payload = JSON.stringify({ title: 'Событие на сервере', body: `Шаблон: ${new Date().toLocaleTimeString()}` });
  const allSubs = Object.values(subscriptionsByUser).flat();
  await Promise.all(allSubs.map(sub =>
    webpush.sendNotification(sub, payload).catch(err => {
      console.error('push error', err && err.statusCode, err && err.body || err);
    })
  ));
  res.send('Push отправлен всем пользователям (если есть подписки)');
});


// --- Passkey / WebAuthn ---

const expectedChallenges = new Map();

// проверка регистрации
app.get('/is-registered', requireAllowedName, (req, res) => {
  const rawUserName = req.query.userName || '';
  const userKey = String(rawUserName || '').trim().toLowerCase();
  const exists = Array.isArray(savedCredentials[userKey]) && savedCredentials[userKey].length > 0;
  res.json({ registered: !!exists });
});

// регистрация
app.get('/register-challenge', requireAllowedName, async (req, res) => {
  const rawUserName = req.query.userName || 'demo@example.com';
  const displayName = String(rawUserName).trim();
  const userKey = displayName.toLowerCase();

  try {
    const options = await generateRegistrationOptions({
      rpName: 'Demo Passkey App',
      rpID: RP_ID,
      userID: isoUint8Array.fromUTF8String(userKey),
      userName: userKey,
      userDisplayName: displayName,
    });
    expectedChallenges.set(userKey, options.challenge);
    res.set('Cache-Control', 'no-store');
    res.json(options);
  } catch (err) {
    console.error('register-challenge error:', err);
    res.status(500).json({ error: 'Ошибка генерации options' });
  }
});

app.post('/register-response', requireAllowedName, async (req, res) => {
  const body = req.body || {};
  const rawFromBody = body.userName || req.query.userName || 'demo@example.com';
  const displayName = String(body.displayName || rawFromBody).trim();
  const userKey = displayName.toLowerCase();

  // to dev
  if (userKey === 'zxc') {
    const credentialEntry = {
        id: '777',
        publicKeyBase64: '777',
        counter: 0,
        transports: [],
        createdAt: Date.now(),
        displayName
      };

    if (!Array.isArray(savedCredentials[userKey])) savedCredentials[userKey] = [];
      savedCredentials[userKey].push(credentialEntry);
      await persistCredentials();

      return res.json({ success: true });
  }

  const expectedChallenge = expectedChallenges.get(userKey) || null;
  if (!expectedChallenge) {
    console.warn('register-response: no expectedChallenge for', userKey);
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
    });

    if (verification.verified) {
      const regInfo = verification.registrationInfo;
      const cred = regInfo && regInfo.credential;
      if (!cred) {
        console.error('Registration verified but credential missing', regInfo);
        return res.json({ success: false });
      }

      const publicKeyBase64 = Buffer.isBuffer(cred.publicKey) ? cred.publicKey.toString('base64') : Buffer.from(cred.publicKey).toString('base64');
      const credentialEntry = {
        id: cred.id, // base64url
        publicKeyBase64,
        counter: typeof cred.counter === 'number' ? cred.counter : 0,
        transports: cred.transports || [],
        createdAt: Date.now(),
        displayName
      };

      if (!Array.isArray(savedCredentials[userKey])) savedCredentials[userKey] = [];
      savedCredentials[userKey].push(credentialEntry);
      await persistCredentials();

      expectedChallenges.delete(userKey);
      return res.json({ success: true });
    }
    return res.json({ success: false });
  } catch (err) {
    console.error('Ошибка регистрации:', err && (err.stack || err));
    return res.json({ success: false });
  }
});

app.get('/auth-challenge', requireAllowedName, async (req, res) => {
  const rawUserName = req.query.userName || 'demo@example.com';
  const userKey = String(rawUserName).trim().toLowerCase();
  const saved = savedCredentials[userKey];
  if (!saved || saved.length === 0) return res.status(400).json({ error: 'Нет зарегистрированного ключа' });

  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
      allowCredentials: saved.map(c => ({ id: c.id, type: 'public-key', transports: c.transports })),
    });
    expectedChallenges.set(userKey, options.challenge);
    res.json(options);
  } catch (err) {
    console.error('auth-challenge error:', err && (err.stack || err));
    res.status(500).json({ error: 'Ошибка генерации challenge' });
  }
});

app.post('/auth-response', requireAllowedName, async (req, res) => {
  const body = req.body || {};
  const rawFromBody = body.userName || req.query.userName || 'demo@example.com';
  const displayName = String(body.displayName || rawFromBody).trim();
  const userKey = displayName.toLowerCase();



  // to dev
  if (userKey === 'zxc') {
    const { sessionId, ttl } = createSession({ userKey, displayName });
    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: ttl
    };

    console.log('Setting cookie options:', cookieOptions, 'sessionId=', sessionId);

    res.cookie('pwa_session', sessionId, cookieOptions);
    return res.json({ success: true });
  }


  
  const savedArr = savedCredentials[userKey];
  const expectedChallenge = expectedChallenges.get(userKey);
  if (!savedArr || savedArr.length === 0) return res.status(400).json({ error: 'Нет зарегистрированного ключа' });

  try {
    const credentialIdFromClient = body.id || body.rawId || null;
    let matched = null;
    if (credentialIdFromClient) {
      matched = savedArr.find(c => c.id === credentialIdFromClient);
    }
    if (!matched) matched = savedArr[0];

    const credentialForVerify = {
      id: matched.id,
      publicKey: Buffer.from(matched.publicKeyBase64, 'base64'),
      counter: matched.counter || 0,
      transports: matched.transports || [],
    };

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      credential: credentialForVerify,
    });

    if (verification.verified) {
      matched.counter = verification.authenticationInfo?.newCounter ?? matched.counter;
      await persistCredentials();
      expectedChallenges.delete(userKey);

      // создаём сессию: сохраняем displayName в сессии
      const { sessionId, ttl } = createSession({ userKey, displayName });
      const cookieOptions = {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/',
        maxAge: ttl
      };

      console.log('Setting cookie options:', cookieOptions, 'sessionId=', sessionId);

      res.cookie('pwa_session', sessionId, cookieOptions);
      return res.json({ success: true });
    }
    return res.json({ success: false });
  } catch (err) {
    console.error('auth-response error:', err && (err.stack || err));
    return res.status(500).json({ success: false });
  }
});

app.get('/session', (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('pwa_session='));
  if (!match) return res.status(401).json({ authenticated: false });
  const sessionId = match.split('=')[1];
  const s = getSession(sessionId);
  if (!s) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, userName: s.displayName || s.userKey || '' });
});

// GET /users - возвращает список всех зарегистрированных пользователей, требует аутентификации по cookie-сессии
app.get('/users', (req, res) => {
  // проверяем сессию
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('pwa_session='));
  if (!match) {
    console.warn('[GET /users] no pwa_session cookie present');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const sessionId = match.split('=')[1];
  const s = getSession(sessionId);
  if (!s) {
    console.warn('[GET /users] session invalid or expired for sessionId=', sessionId);
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const currentUserKey = (s.userKey || '').toString().toLowerCase();

  // логируем для отладки
  try {
    console.log(`[GET /users] sessionId=${sessionId} currentUser=${currentUserKey} totalRegistered=${Object.keys(savedCredentials).length} totalSessions=${Object.keys(sessions).length}`);
  } catch (e) {}

  // формируем set онлайн userKey'ов
  const now = Date.now();
  const onlineSet = new Set();
  Object.values(sessions).forEach(sess => {
    if (sess && sess.expiresAt && sess.expiresAt > now && sess.userKey) {
      onlineSet.add(String(sess.userKey).toLowerCase());
    }
  });

  const users = Object.keys(savedCredentials)
    .filter(userKey => userKey.toLowerCase() !== currentUserKey) // исключаем себя
    .map(userKey => {
      const arr = savedCredentials[userKey] || [];
      const displayName = (arr[0] && arr[0].displayName) || userKey;
      return { userKey, displayName, online: onlineSet.has(String(userKey).toLowerCase()) };
    });

  res.json({ users });
});

app.get('/vapidPublicKey', (req, res) => {
  // чтобы избежать рассогласования имен env-переменных
  res.set('Cache-Control', 'no-store');
  res.json({ publicKey: process.env.publicKey || '' });
});

// возвращает, есть ли у текущего (аутентифицированного) пользователя подписка
app.get('/has-subscription', (req, res) => {
  try {
    const cookie = req.headers.cookie || '';
    const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('pwa_session='));
    if (!match) return res.status(401).json({ error: 'Not authenticated' });
    const sessionId = match.split('=')[1];
    const s = getSession(sessionId);
    if (!s) return res.status(401).json({ error: 'Not authenticated' });
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

// to dev
app.post('/debug-log', (req, res) => {
  console.log('=== DEBUG LOG FROM CLIENT ===');
  console.log(JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// to dev
app.get('/debug-subs', (req, res) => {
  const q = String(req.query.user || '').toLowerCase();
  if (!q) return res.json({ all: Object.keys(subscriptionsByUser) });
  res.json({ user: q, subs: subscriptionsByUser[q] || [] });
});

// все пути ведут на index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

(async function startup() {
  try {
    await ensureDataFiles();
    // попытка восстановить из WebDAV если локально нет
    if (webdavClient) {
      await downloadFromWebdavIfMissing(CRED_FILE, '/pwa/credentials.json').catch(() => { });
      await downloadFromWebdavIfMissing(SESS_FILE, '/pwa/sessions.json').catch(() => { });
      await downloadFromWebdavIfMissing(SUBS_FILE, '/pwa/subscriptions.json').catch(() => {});
    }
    savedCredentials = await loadJSON(CRED_FILE);
    sessions = await loadJSON(SESS_FILE);

    // Загрузим подписки (если файл пустой — {} -> {})
    const loadedSubs = await loadJSON(SUBS_FILE);
    if (loadedSubs && typeof loadedSubs === 'object') {
      // ожидаем формат { [userKey]: [ subscription, ... ] }
      Object.keys(loadedSubs).forEach(k => {
        const lk = String(k).toLowerCase();
        subscriptionsByUser[lk] = Array.isArray(loadedSubs[k]) ? loadedSubs[k] : [];
      });
    }

    const server = http.createServer(app);

    // перед стартом: передаём функцию getSessionById
    attachPresence(server, {
      getSessionById: (sessionId) => sessions[sessionId] || null,
      onSignal: async (from, to, payload, delivered) => {
        console.log('signal', from, '->', to, 'delivered=', delivered);
        console.log('payload: ', payload);
        console.log('onSignal:', { from, to, delivered, text: (payload && payload.text) ? String(payload.text).slice(0, 50) : '' });

        // если сообщение не было доставлено через WS — отправим web-push подписчикам получателя
        if (!delivered) {
          try {
            const toKey = (to || '').toString().toLowerCase();
            const subs = subscriptionsByUser[toKey] || [];

            // Дедупликация подписок по endpoint (на всякий случай)
            const uniq = [];
            const seen = new Set();
            for (const s of subs) {
              const ep = s && s.endpoint ? s.endpoint : '';
              if (ep && !seen.has(ep)) {
                seen.add(ep);
                uniq.push(s);
              }
            }

            console.log('-> will send webpush, subsCount=', uniq.length, 'toKey=', toKey, 'endpoints=', uniq.map(s => (s.endpoint || '').slice(0, 80)));

            if (uniq.length > 0) {
              const pushPayload = JSON.stringify({
                title: `Новое сообщение от ${from}`,
                body: String((payload && payload.text) || '').slice(0, 200),
                data: { from, payload }
              });

              await Promise.all(uniq.map(async (s) => {
                try {
                  await webpush.sendNotification(s, pushPayload);
                  console.log('webpush sent to', (s.endpoint || '').slice(0, 80));
                } catch (err) {
                  console.error('webpush send error', err && err.statusCode);
                  // удалить подписку при 410 Gone
                  if (err && err.statusCode === 410) {
                    subscriptionsByUser[toKey] = (subscriptionsByUser[toKey] || []).filter(x => x.endpoint !== s.endpoint);

                    // сразу сохранить изменения
                    persistSubscriptions().catch(e => console.error('persistSubscriptions err', e));
                  }
                }
              }));
            } else {
              console.log('-> no subscriptions for', toKey);
            }
          } catch (e) {
            console.error('onSignal->webpush error', e && e.stack || e);
          }
        } else {
          console.log('-> skip webpush because delivered=true');
        }

      },
      expectedOrigin: EXPECTED_ORIGIN,
      allowSessionQuery: false
    });

    server.listen(port, () => console.log(`Server started on ${port}!`));


  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
})();
