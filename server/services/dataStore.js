// --- работа с JSON и WebDAV

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');

const { DATA_DIR, CRED_FILE, SESS_FILE, SUBS_FILE, subscriptionsByUser } = require('../config/config');
const state = require('../config/state');

// проверяем наличие файлов
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

// читаем JSON
async function loadJSON(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw || '{}');
}

// сохраняем JSON
async function saveJSON(file, obj) {
  const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// сохраняем креды
async function persistCredentials() {
  await saveJSON(CRED_FILE, state.savedCredentials);
  if (state.webdavClient) {
    // загрузим в /pwa/credentials.json (пусть будет папка pwa)
    await uploadToWebdav(CRED_FILE, '/pwa/credentials.json');
  }
}

// сохраняем сессии
async function persistSessions() {
  await saveJSON(SESS_FILE, state.sessions);
  if (state.webdavClient) {
    await uploadToWebdav(SESS_FILE, '/pwa/sessions.json');
  }
}

// сохраняем подписки
async function persistSubscriptions() {
  try {
    await saveJSON(SUBS_FILE, subscriptionsByUser);
    if (state.webdavClient) {
      await uploadToWebdav(SUBS_FILE, '/pwa/subscriptions.json');
    }
  } catch (e) {
    console.error('persistSubscriptions error', e && e.message);
  }
}

// загрузка в WebDAV
async function uploadToWebdav(localPath, remotePath) {
  if (!state.webdavClient) return;
  try {
    // постфикс: remotePath = '/pwa/credentials.json' -> dir = '/pwa'
    const dir = path.posix.dirname(remotePath);
    // попробуем убедиться, что папка есть
    await ensureRemoteDir(dir);

    const content = await fsp.readFile(localPath);
    await state.webdavClient.putFileContents(remotePath, content, { overwrite: true });
    console.log('WebDAV: uploaded', remotePath);
  } catch (e) {
    // если 409 — попробуем создать директорию и повторить
    const msg = e && e.message ? e.message : String(e);
    if (msg.includes('409') || msg.toLowerCase().includes('conflict')) {
      try {
        const dir = path.posix.dirname(remotePath);
        await ensureRemoteDir(dir);
        const content = await fsp.readFile(localPath);
        await state.webdavClient.putFileContents(remotePath, content, { overwrite: true });
        console.log('WebDAV: uploaded after mkdir', remotePath);
        return;
      } catch (ee) {
        console.error('WebDAV upload retry failed', remotePath, ee && ee.message);
      }
    }
    console.error('WebDAV upload error', remotePath, msg);
  }
}

// восстановление из WebDAV
async function downloadFromWebdavIfMissing(localPath, remotePath) {
  if (!state.webdavClient) return false;
  try {
    const data = await state.webdavClient.getFileContents(remotePath);
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

// проверка/создание папки в WebDAV
async function ensureRemoteDir(remoteDir) {
  if (!state.webdavClient) return false;
  try {
    await state.webdavClient.stat(remoteDir);
    return true;
  } catch (err) {
    // если не найден — создаём (createDirectory рекурсивно создаст если поддерживается)
    try {
      await state.webdavClient.createDirectory(remoteDir);
      return true;
    } catch (e) {
      console.warn('WebDAV: createDirectory failed for', remoteDir, e && e.message);
      return false;
    }
  }
}


module.exports = {
  ensureDataFiles,
  loadJSON,
  persistCredentials,
  persistSessions,
  persistSubscriptions,
  downloadFromWebdavIfMissing,
};
