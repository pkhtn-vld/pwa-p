import sodium from 'libsodium-wrappers';
import { openDB } from 'idb';

const DB_NAME = 'pwa-chat';
const DB_VERSION = 1;
const STORE_KEYS = 'keys';       // хранит нашу пару ключей, запись с id='sodium'
const STORE_PUBKEYS = 'pubkeys';// кеш публичных ключей других пользователей { userKey, publicKeyBase64 }
const STORE_MESSAGES = 'messages'; // история

async function open() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_PUBKEYS)) db.createObjectStore(STORE_PUBKEYS, { keyPath: 'userKey' });
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) db.createObjectStore(STORE_MESSAGES, { keyPath: 'id', autoIncrement: true });
    }
  });
}

// гарантирует, что libsodium готов.
async function readySodium() {
  await sodium.ready;
  return sodium;
}

// утилиты base64
function u8ToB64(u8) {
  return sodium.to_base64(u8, sodium.base64_variants.ORIGINAL);
}
function b64ToU8(b64) {
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

// ключи: генерация + хранение
// если ключей ещё нет в IndexedDB -> генерирует пару crypto_box_keypair()
// сохраняет { id: 'sodium', publicKeyBase64, privateKeyBase64 }
// пытается сразу POST /upload-pubkey с publicKey
// Возвращает запись ключей
export async function ensureKeypair(userKey) {
  const db = await open();
  const existing = await db.get(STORE_KEYS, 'sodium');
  if (existing && existing.publicKeyBase64 && existing.privateKeyBase64) {
    console.log('[sodium] existing keypair found in IDB');
    return existing;
  }

  console.log('[sodium] generating new keypair...');
  await readySodium();
  const kp = sodium.crypto_box_keypair();

  const rec = {
    id: 'sodium',
    publicKeyBase64: u8ToB64(kp.publicKey),
    privateKeyBase64: u8ToB64(kp.privateKey),
    createdAt: Date.now()
  };

  await db.put(STORE_KEYS, rec);
  console.log('[sodium] keypair saved to IndexedDB (id="sodium")', { userKey, publicKeyB64: rec.publicKeyBase64.slice(0, 12) + '...' });

  // Попытка загрузить публичный ключ на сервер (авто)
  try {
    console.log('[sodium] uploading public key to server /upload-pubkey ...');
    const resp = await fetch('/upload-pubkey', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: rec.publicKeyBase64 })
    });
    if (resp.ok) {
      console.log('[sodium] uploaded public key to server successfully for', userKey);
    } else {
      console.warn('[sodium] upload-pubkey returned non-ok', resp.status, await resp.text());
    }
  } catch (err) {
    console.warn('[sodium] upload-pubkey failed', err && err.message ? err.message : err);
  }

  return rec;
}

// getLocalKeypair()
// возвращает запись с IDB (или null)
export async function getLocalKeypair() {
  const db = await open();
  return db.get(STORE_KEYS, 'sodium');
}

// кеш публичных ключей других пользователей
// cachePubkey(userKey, publicKeyBase64) - сохранить в локальный кеш
export async function cachePubkey(userKey, publicKeyBase64) {
  const db = await open();
  const key = String(userKey).toLowerCase();
  await db.put(STORE_PUBKEYS, { userKey: key, publicKeyBase64, updatedAt: Date.now() });
  console.log('[sodium] cached pubkey for', key, publicKeyBase64 ? publicKeyBase64.slice(0, 12) + '...' : null);
}

// getCachedPubkey(userKey) - вернуть из кеша (или null)
export async function getCachedPubkey(userKey) {
  const db = await open();
  const rec = await db.get(STORE_PUBKEYS, String(userKey).toLowerCase());
  return rec && rec.publicKeyBase64 ? rec.publicKeyBase64 : null;
}

// fetchAndCachePubkey(userKey) - GET /pubkey?user=... -> кешировать и вернуть (или null)
export async function fetchAndCachePubkey(userKey) {
  try {
    const q = encodeURIComponent(String(userKey).toLowerCase());
    console.log('[sodium] fetching pubkey from server for', userKey);
    const r = await fetch(`/pubkey?user=${q}`, { credentials: 'include' });
    if (!r.ok) {
      console.warn('[sodium] /pubkey returned', r.status);
      return null;
    }
    const j = await r.json();
    if (j && j.publicKey) {
      await cachePubkey(userKey, j.publicKey);
      return j.publicKey;
    }
  } catch (e) {
    console.warn('[sodium] fetchAndCachePubkey failed', e && e.message ? e.message : e);
  }
  return null;
}

// getPubkey(userKey) - сначала из кеша, иначе с сервера
export async function getPubkey(userKey) {
  if (!userKey) return null;
  const cached = await getCachedPubkey(userKey);
  if (cached) return cached;
  return fetchAndCachePubkey(userKey);
}

// шифрование / расшифровка
//encryptForPublicBase64(recipientPublicBase64, text) - шифрует строку и возвращает base64 cipher
export async function encryptForPublicBase64(recipientPublicBase64, text) {
  await readySodium();
  if (!recipientPublicBase64) throw new Error('recipientPublicBase64 required');
  const msgU8 = sodium.from_string(String(text || ''));
  const pk = b64ToU8(recipientPublicBase64);
  const cipher = sodium.crypto_box_seal(msgU8, pk);
  const cipherB64 = u8ToB64(cipher);
  return cipherB64;
}

// decryptOwn(ciphertextBase64) - расшифровать сообщение, зашифрованное crypto_box_seal,
// используя локальную пару (public+private). Возвращает plaintext string либо бросает ошибку.
export async function decryptOwn(ciphertextBase64) {
  await readySodium();
  const db = await open();
  const keys = await db.get(STORE_KEYS, 'sodium');
  if (!keys || !keys.privateKeyBase64 || !keys.publicKeyBase64) throw new Error('No local sodium keypair in IDB');
  try {
    const pk = b64ToU8(keys.publicKeyBase64);
    const sk = b64ToU8(keys.privateKeyBase64);
    const cipher = b64ToU8(ciphertextBase64);
    const plainU8 = sodium.crypto_box_seal_open(cipher, pk, sk);
    const plain = sodium.to_string(plainU8);
    return plain;
  } catch (e) {
    throw new Error('decrypt failed: ' + (e && e.message ? e.message : e));
  }
}

// функция для обновления записи сообщения в IDB
export async function updateMessageDeliveryStatus(recipient, ts, status) {
  try {
    const db = await open();
    const me = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();
    const all = await db.getAll(STORE_MESSAGES);
    // найдём запись: from = me, to = recipient, ts = ts и meta.localCopy = true
    const rec = all.find(r =>
      String(r.from || '').toLowerCase() === me &&
      String(r.to || '').toLowerCase() === String(recipient || '').toLowerCase() &&
      Number(r.ts || 0) === Number(ts) &&
      r.meta && r.meta.localCopy
    );
    if (!rec) return false;
    rec.meta = rec.meta || {};
    rec.meta.delivery = status; // 'pending'|'sent'|'read'|'failed'
    await db.put(STORE_MESSAGES, rec);
    console.log('[msg] updated delivery status in IDB', { to: recipient, ts, status });
    return true;
  } catch (e) {
    console.warn('[msg] updateMessageDeliveryStatus failed', e && e.message ? e.message : e);
    return false;
  }
}

// saveMessageLocal(msg)
// msg shape example:
// { from, to, text, encrypted: true|false, ts: number, meta: {...}, read: true|false }
export async function saveMessageLocal(msg) {
  const db = await open();

  // Нормализуем поля, выставляем ts и default для read.
  const normalized = {
    from: (msg.from == null) ? null : String(msg.from).toLowerCase(),
    to: (msg.to == null) ? null : String(msg.to).toLowerCase(),
    text: msg.text,
    encrypted: !!msg.encrypted,
    ts: msg.ts || Date.now(),
    meta: (msg.meta && typeof msg.meta === 'object') ? msg.meta : {},
    read: !!msg.read // по умолчанию false
  };

  try {
    await db.add(STORE_MESSAGES, normalized);
    console.log('[msg] saved to IDB', { from: normalized.from, to: normalized.to, encrypted: normalized.encrypted, ts: normalized.ts, read: normalized.read });
  } catch (e) {
    // Возможны случаи, когда добавление провалилось (ретрай/логика)
    console.warn('[msg] save to IDB failed', e && e.message ? e.message : e);
    throw e;
  }
}

// getMessagesWith(userKey) - вернуть все сообщения с/к userKey, отсортированные по ts
export async function getMessagesWith(userKey) {
  const db = await open();
  const arr = await db.getAll(STORE_MESSAGES);
  const k = String(userKey).toLowerCase();
  const res = arr.filter(m => (String(m.from || '').toLowerCase() === k) || (String(m.to || '').toLowerCase() === k))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return res;
}

// экспорт набора утилит
export default {
  ensureKeypair,
  getLocalKeypair,
  getPubkey,
  encryptForPublicBase64,
  decryptOwn,
  saveMessageLocal,
  getMessagesWith,
  cachePubkey,
  getCachedPubkey,
  updateMessageDeliveryStatus
};
