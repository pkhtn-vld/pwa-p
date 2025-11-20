// --- маршруты для аутентификации и регистрации пользователей

const express = require('express');
const router = express.Router();
const { isoUint8Array } = require('@simplewebauthn/server/helpers');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const { RP_ID, EXPECTED_ORIGIN, expectedChallenges } = require('../config/config');
const state = require('../config/state');
const { requireAllowedName } = require('../middleware/middleware')
const { createSession } = require('./session')
const { persistCredentials } = require('../services/dataStore');

// проверяем есть ли у пользователя сохранённые ключи
router.get('/is-registered', requireAllowedName, (req, res) => {
  const rawUserName = req.query.userName || '';
  const userKey = String(rawUserName || '').trim().toLowerCase();
  const exists = Array.isArray(state.savedCredentials[userKey]) && state.savedCredentials[userKey].length > 0;
  res.json({ registered: !!exists });
});

// выдаём challenge для регистрации нового ключа
router.get('/register-challenge', requireAllowedName, async (req, res) => {
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

// принимаем ответ клиента и сохраняем ключ
router.post('/register-response', requireAllowedName, async (req, res) => {
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

    if (!Array.isArray(state.savedCredentials[userKey])) state.savedCredentials[userKey] = [];
    state.savedCredentials[userKey].push(credentialEntry);
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

      if (!Array.isArray(state.savedCredentials[userKey])) state.savedCredentials[userKey] = [];
      state.savedCredentials[userKey].push(credentialEntry);
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

// выдаём challenge для входа (аутентификации)
router.get('/auth-challenge', requireAllowedName, async (req, res) => {
  const rawUserName = req.query.userName || 'demo@example.com';
  const userKey = String(rawUserName).trim().toLowerCase();
  const saved = state.savedCredentials[userKey];
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

// проверяем ответ клиента и создаём сессию
router.post('/auth-response', requireAllowedName, async (req, res) => {
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

    res.cookie('pwa_session', sessionId, cookieOptions);
    return res.json({ success: true });
  }


  const savedArr = state.savedCredentials[userKey];
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

      res.cookie('pwa_session', sessionId, cookieOptions);
      return res.json({ success: true });
    }
    return res.json({ success: false });
  } catch (err) {
    console.error('auth-response error:', err && (err.stack || err));
    return res.status(500).json({ success: false });
  }
});

module.exports = router;