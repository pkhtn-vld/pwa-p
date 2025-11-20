// загружаем конфиг из .env и настраиваем окружение

const path = require('path');
const { createClient: createWebdavClient } = require('webdav');
const webpush = require('web-push');

const state = require('./state');

// основные параметры окружения
const port = process.env.PORT || 3000;
const RP_ID = process.env.RP_ID || 'localhost';
const EXPECTED_ORIGIN = process.env.ORIGIN || `http://localhost:${port}`;

// ключи для web-push
const VAPID_PUBLIC = process.env.publicKey;
const VAPID_PRIVATE = process.env.privateKey;

// креды для WebDAV
const WEBDAV_BASE = process.env.WEBDAV_BASE || 'https://webdav.cloud.mail.ru';
const WEBDAV_USER = process.env.WEBDAV_USER || '';
const WEBDAV_PASS = process.env.WEBDAV_PASS || '';

// пути
const DATA_DIR = path.join(__dirname, 'data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

// Храним подписки по userKey: { [userKey]: [ subscription, ... ] }
const subscriptionsByUser = {};

// Passkey / WebAuthn
const expectedChallenges = new Map();

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:ex@mail.com', VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('VAPID-ключи не нейдены');
}

if (WEBDAV_USER && WEBDAV_PASS) {
  state.webdavClient = createWebdavClient(WEBDAV_BASE, { username: WEBDAV_USER, password: WEBDAV_PASS });
}


module.exports = {
  webpush,
  port,
  RP_ID,
  EXPECTED_ORIGIN,
  VAPID_PUBLIC,
  VAPID_PRIVATE,
  WEBDAV_BASE,
  WEBDAV_USER,
  WEBDAV_PASS,
  DATA_DIR,
  CRED_FILE,
  SESS_FILE,
  SUBS_FILE,
  subscriptionsByUser,
  expectedChallenges
};
