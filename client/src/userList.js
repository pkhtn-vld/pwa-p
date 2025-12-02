import {
  getPubkey,
  encryptForPublicBase64,
  decryptOwn,
  saveMessageLocal,
  getMessagesWith,
  getLocalKeypair,
  fetchAndCachePubkey,
  updateMessageDeliveryStatus
} from './cryptoSodium.js';
import { state } from './state.js';
import { isSameDay, formatTimeOnly, formatDateHeader, normKey } from './utils.js';
import { createTopBarIfMissing } from './ui.js';
import { initiateCallTo } from './userCall.js';


// открыть БД pwa-chat и вернуть Promise<db>
function openChatDB() {
  return new Promise((resolve, reject) => {
    try {
      const rq = indexedDB.open('pwa-chat', 1);
      rq.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('messages')) {
          db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        }
      };
      rq.onsuccess = function (e) { resolve(e.target.result); };
      rq.onerror = function (e) { reject(e); };
    } catch (err) { reject(err); }
  });
}

// посчитать количество непрочитанных сообщений от userKey
function countUnreadFor(userKey) {
  return new Promise(async (resolve) => {
    try {
      const me = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();
      const k = normKey(userKey);
      const db = await openChatDB();
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const req = store.openCursor();
      let cnt = 0;
      req.onsuccess = function (ev) {
        const cursor = ev.target.result;
        if (!cursor) {
          db.close();
          resolve(cnt);
          return;
        }
        const rec = cursor.value;
        const from = (rec.from || '').toLowerCase();
        const to = rec.to ? String(rec.to).toLowerCase() : (rec.to === null ? null : '');
        const viaPush = rec.meta && rec.meta.via === 'push';
        const readFlag = !!rec.read;
        if (!readFlag) {
          if ((to && me && to === me && from === k) || (viaPush && from === k)) {
            cnt++;
          }
        }
        cursor.continue();
      };
      req.onerror = function () { db.close(); resolve(0); };
    } catch (e) {
      console.warn('[unread] countUnreadFor failed', e);
      resolve(0);
    }
  });
}

// пометить все сообщения для userKey как прочитанные (read=true)
export function markAllReadFor(userKey) {
  return new Promise(async (resolve) => {
    try {
      const me = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();
      const k = normKey(userKey);
      const db = await openChatDB();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const req = store.openCursor();

      // Собираем ts сообщений, которые мы пометили read=true в этой транзакции.
      const changedTs = [];

      req.onsuccess = function (ev) {
        const cursor = ev.target.result;
        if (!cursor) {
          // транзакция завершится; в tx.oncomplete отправим receipts
          tx.oncomplete = function () {
            try {
              db.close();
            } catch (e) { /* ignore */ }

            // После успешного обновления в IDB — отправляем read receipts.
            // Если state.presenceClient отсутствует — sendSignal вернёт false или буферизует в клиенте,
            // но мы по крайней мере сделали попытку отправки и залогировали это.
            (async () => {
              if (!changedTs.length) {
                console.log('[markAllReadFor] nothing changed, no receipts to send for', k);
                resolve();
                return;
              }

              console.log('[markAllReadFor] will send read receipts for ts list', { to: k, count: changedTs.length });

              for (const t of changedTs) {
                try {
                  if (state.presenceClient && typeof state.presenceClient.sendSignal === 'function') {
                    const payload = { type: 'chat_receipt', ts: Number(t), status: 'read' };
                    const ok = state.presenceClient.sendSignal(k, payload);
                    console.log('[markAllReadFor] sent read receipt attempt', { to: k, ts: t, ok });
                  } else {
                    console.warn('[markAllReadFor] no state.presenceClient to send receipt to', k, t);
                  }
                } catch (e) {
                  console.warn('[markAllReadFor] failed to send read receipt', { to: k, ts: t, err: e && e.message ? e.message : e });
                }
              }
              resolve();
            })();
          };
          return;
        }

        const rec = cursor.value;
        const from = (rec.from || '').toLowerCase();
        const to = rec.to ? String(rec.to).toLowerCase() : (rec.to === null ? null : '');
        const viaPush = rec.meta && rec.meta.via === 'push';

        // Только если не помечено read — ставим read=true
        if (!rec.read) {
          if ((to && me && to === me && from === k) || (viaPush && from === k)) {
            // Помечаем прочитанным
            rec.read = true;
            cursor.update(rec);
            if (rec.ts) {
              changedTs.push(Number(rec.ts));
              console.log('[markAllReadFor] marking record read (will send receipt later)', { from: rec.from, to: rec.to, ts: rec.ts });
            } else {
              console.log('[markAllReadFor] marking record read (no ts) ', { rec });
            }
          }
        }

        cursor.continue();
      };

      req.onerror = function (err) {
        try { db.close(); } catch (e) { }
        console.warn('[markAllReadFor] cursor error', err);
        resolve();
      };
    } catch (e) {
      console.warn('[unread] markAllReadFor failed', e);
      resolve();
    }
  });
}

// DOM-обновления бейджа (на основе IDB)

// обновляет бейдж для одного userKey, считая из IDB
export function updateUnreadBadge(userKey) {
  try {
    const k = normKey(userKey);
    const row = document.querySelector(`.user-row[data-userkey="${k}"]`);
    if (!row) return Promise.resolve();
    const badge = row.querySelector('.unread-badge');
    if (!badge) return Promise.resolve();

    // ставим прелоад (скрытый) — затем асинхронно обновим
    badge.style.display = 'none';
    badge.textContent = '';

    return countUnreadFor(k).then(cnt => {
      if (!badge) return;
      if (cnt <= 0) {
        badge.style.display = 'none';
        badge.textContent = '';
        badge.setAttribute('aria-hidden', 'true');
      } else {
        badge.style.display = 'inline-block';
        const display = cnt > 99 ? '99+' : String(cnt);
        badge.textContent = display;
        badge.style.background = '#0b93f6';
        badge.style.color = '#fff';
        badge.style.borderRadius = '999px';
        badge.style.padding = '2px 8px';
        badge.style.fontSize = '12px';
        badge.style.lineHeight = '1';
        badge.style.minWidth = '24px';
        badge.style.textAlign = 'center';
        badge.style.boxSizing = 'border-box';
        badge.setAttribute('aria-hidden', 'false');
      }
    }).catch(err => {
      console.warn('[unread] updateUnreadBadge count failed', err);
    });
  } catch (e) {
    console.warn('[unread] updateUnreadBadge failed', e);
    return Promise.resolve();
  }
}

// инициализация: сканируем IDB и сразу обновляем бейджи
export async function initUnreadFromIDB() {
  try {
    updateAllBadges();
  } catch (e) {
    console.warn('[unread] initUnreadFromIDB error', e);
  }
}

// Обновить бейджи для всех user-row'ов
export function updateAllBadges() {
  try {
    const rows = document.querySelectorAll('.user-row');
    rows.forEach(r => {
      const userKey = r.getAttribute('data-userkey');
      if (userKey) updateUnreadBadge(userKey);
    });
  } catch (e) { /* ignore */ }
}

// проверка открыт ли чат с userKey
export function isChatOpenWith(userKey) {
  if (!userKey) return false;
  return String(state.currentOpenChatUserKey || '').toLowerCase() === String(userKey || '').toLowerCase();
}

// всплывающие сообщения
export function showInAppToast(title, meta = {}) {
  try {
    const id = 'inapp-toast';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.position = 'fixed';
      el.style.right = '12px';
      el.style.bottom = '12px';
      el.style.zIndex = 99999;
      el.style.maxWidth = '90%';
      el.style.padding = '10px 14px';
      el.style.background = 'rgba(0,0,0,0.85)';
      el.style.color = '#fff';
      el.style.borderRadius = '8px';
      el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
      document.body.appendChild(el);
    }
    el.textContent = `${title}`;
    el.style.display = 'block';
    // исчезает через 4 сек
    setTimeout(() => { try { el.style.display = 'none'; } catch (e) { } }, 4000);
  } catch (e) {
    console.log('toast fallback', title);
  }
}

// экспорт функции обновления статусов
export function updateOnlineList(onlineArray) {
  state.onlineSet = new Set((onlineArray || []).map(x => String(x).toLowerCase()));
  const container = document.getElementById('userList');
  if (!container) return;
  const rows = container.querySelectorAll('.user-row');
  rows.forEach(row => {
    const userKey = row.getAttribute('data-userkey') || '';
    const dot = row.querySelector('.status-dot');
    if (dot) {
      dot.style.color = state.onlineSet.has(userKey.toLowerCase()) ? '#28a745' : '#9AA0A6';
    }
  });

  // Если открыт чат — обновим статус в заголовке чата (если совпадает)
  if (state.currentChat && state.currentChat.userKey) {
    updateChatStatusDot(state.currentChat.userKey);
  }
}

// для обновления точки в заголовке чата
function updateChatStatusDot(userKey) {
  try {
    if (!userKey) return;
    const dot = document.getElementById('chatStatusDot');
    if (!dot) return;
    const isOnline = state.onlineSet.has(String(userKey).toLowerCase());
    dot.style.color = isOnline ? '#28a745' : '#9AA0A6';
    dot.title = isOnline ? 'онлайн' : 'оффлайн';
  } catch (e) { /* ignore */ }
}

// устанавливает текст и аватар в верхней полосе
export function ensureTopBar(displayName) {
  const top = createTopBarIfMissing();
  const nameEl = document.getElementById('topBarName');
  const avatar = document.getElementById('topBarAvatar');
  const statusEl = document.getElementById('topBarStatus');

  const dn = (displayName || '').trim();
  if (nameEl) nameEl.textContent = dn || 'Пользователь';
  if (avatar) avatar.textContent = dn ? dn[0].toUpperCase() : '?';
  if (statusEl) statusEl.textContent = 'online';
}

// users list UI: загрузка и отрисовка
function renderUserList(users) {
  // создаём контейнер, если его нет
  let container = document.getElementById('userList');
  if (!container) {
    container = document.createElement('div');
    container.id = 'userList';

    const ref = document.getElementById('result') || document.body;
    if (ref === document.body) {
      document.body.appendChild(container);
    } else {
      ref.insertAdjacentElement('afterend', container);
    }
  }

  // безопасное очищение
  while (container.firstChild) container.removeChild(container.firstChild);

  users.forEach(u => {
    const userKeyNorm = (u.userKey || '').toString().toLowerCase();

    const userDiv = document.createElement('div');
    userDiv.className = 'user-row';
    userDiv.setAttribute('data-userkey', userKeyNorm);

    // left: имя пользователя
    const left = document.createElement('div');
    left.className = 'user-left';

    // аватар-плейсхолдер (круг)
    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.textContent = (u.displayName && u.displayName[0]) ? u.displayName[0].toUpperCase() : (u.userKey && u.userKey[0]) ? u.userKey[0].toUpperCase() : '?';

    const nameEl = document.createElement('div');
    nameEl.style.fontSize = '16px';
    nameEl.style.fontWeight = '500';
    nameEl.textContent = u.displayName || u.userKey;

    left.appendChild(avatar);
    left.appendChild(nameEl);

    // right: три иконки
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '16px';

    // статус активности (иконка — круг)
    const statusBtn = document.createElement('button');
    statusBtn.className = 'user-statusBtn';
    statusBtn.title = 'Статус активности';

    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot';
    statusDot.textContent = '●';
    statusBtn.appendChild(statusDot);

    // иконка сообщения
    const msgBtn = document.createElement('button');
    msgBtn.className = 'user-msg-btn';
    msgBtn.title = 'Написать сообщение';
    msgBtn.textContent = '✉️';
    msgBtn.addEventListener('click', () => {
      openChatForUser({ userKey: userKeyNorm, displayName: u.displayName || userKeyNorm });
    });

    // иконка звонка
    const callBtn = document.createElement('button');
    callBtn.className = 'user-call-btn';
    callBtn.title = 'Позвонить';
    callBtn.textContent = '📞';
    callBtn.addEventListener('click', () => {
      initiateCallTo(userKeyNorm);
      // alert('Инициация звонка пользователю: ' + (u.displayName || userKeyNorm));
    });

    // элемент бейджа непрочитанных
    const unreadBadge = document.createElement('span');
    unreadBadge.className = 'unread-badge';
    unreadBadge.textContent = '●';

    right.appendChild(statusBtn);
    right.appendChild(msgBtn);
    right.appendChild(callBtn);
    right.appendChild(unreadBadge);

    userDiv.appendChild(left);
    userDiv.appendChild(right);

    container.appendChild(userDiv);
    updateUnreadBadge(userKeyNorm);
  });
}

// получить список пользователей с сервера и отрисовать
export async function loadAndRenderUsers() {
  try {
    const r = await fetch('/users', { credentials: 'include' });
    if (!r.ok) {
      console.warn('Не удалось загрузить список пользователей:', r.status);
      return;
    }
    const data = await r.json().catch(async (e) => {
      const txt = await r.text().catch(() => null);
      return null;
    });
    if (!data) return;
    if (data && Array.isArray(data.users)) {
      renderUserList(data.users);
      try {
        await initUnreadFromIDB();
      } catch (e) {
        console.warn('[loadAndRenderUsers] initUnreadFromIDB failed', e);
      }
    } else {
      // неожиданный формат
    }
  } catch (err) {
    console.error('Ошибка при загрузке пользователей:', err);
  }
}

// создание overlay чата
function createChatOverlay() {
  if (document.getElementById('chatOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'chatOverlay';

  const top = document.createElement('div');
  top.id = 'chatTop';

  const back = document.createElement('button');
  back.id = 'chat-back-btn';
  back.textContent = '←';
  back.addEventListener('click', closeChat);

  const titleWrap = document.createElement('div');
  titleWrap.id = 'titleWrap';

  const title = document.createElement('div');
  title.id = 'chatTitle';

  // статусная точка в заголовке
  const statusDot = document.createElement('span');
  statusDot.id = 'chatStatusDot';
  statusDot.title = 'оффлайн';
  statusDot.textContent = '●';

  titleWrap.appendChild(statusDot);
  titleWrap.appendChild(title);

  const right = document.createElement('div');
  right.style.width = '36px';
  top.appendChild(back);
  top.appendChild(titleWrap);
  top.appendChild(right);

  const messages = document.createElement('div');
  messages.id = 'chatMessages';

  const inputWrap = document.createElement('div');
  inputWrap.id = 'inputWrap';

  const input = document.createElement('input');
  input.id = 'chatInput';
  input.type = 'text';
  input.placeholder = 'Написать сообщение';
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      try {
        // дизейблим кнопку чтобы не нажимали несколько раз
        sendBtn.disabled = true;
        await sendChatMessage();
      } catch (err) {
        console.error('[UI] sendChatMessage error', err && (err.stack || err));
        showInAppToast('Ошибка: Не удалось отправить сообщение');
      } finally {
        sendBtn.disabled = false;
      }
    }
  });

  const sendBtn = document.createElement('button');
  sendBtn.id = 'chatSendBtn';
  sendBtn.textContent = '➤';
  sendBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      sendBtn.disabled = true;
      await sendChatMessage();
    } catch (err) {
      console.error('[UI] sendChatMessage error', err && (err.stack || err));
      showInAppToast('Ошибка: Не удалось отправить сообщение');
    } finally {
      sendBtn.disabled = false;
    }
  });
  inputWrap.appendChild(input);
  inputWrap.appendChild(sendBtn);

  overlay.appendChild(top);
  overlay.appendChild(messages);
  overlay.appendChild(inputWrap);
  document.body.appendChild(overlay);
}

// открыть чат пользователя
export function openChatForUser({ userKey, displayName }) {
  state.currentOpenChatUserKey = String(userKey || '').toLowerCase();
  createChatOverlay();
  const normalized = (userKey || '').toString().toLowerCase();
  state.currentChat = { userKey: normalized, displayName: displayName || userKey, messages: [] };

  // Пометим все сообщения этого чата как прочитанные (и обновим бейдж)
  try {
    // это асинхронно: пометим в IDB и затем обновим DOM бейдж
    markAllReadFor(normalized).then(() => {
      updateUnreadBadge(normalized);
    }).catch(() => { /* ignore */ });
  } catch (e) { }

  document.getElementById('chatOverlay').style.display = 'flex';
  document.getElementById('chatTitle').textContent = state.currentChat.displayName;

  // обновим статусную точку
  updateChatStatusDot(state.currentChat.userKey);

  renderMessages();

  // Асинхронно: загрузим историю из IndexedDB и подставим в state.currentChat.messages
  (async () => {
    try {
      console.log('[chat] loading history for', normalized);
      const rows = await getMessagesWith(normalized); // отсортировано по ts
      state.currentChat.messages = []; // заменим текущий буфер на содержимое IDB

      // сгруппируем записи по key = `${ts}|${from}|${to}`
      const groups = new Map();
      for (const r of rows) {
        const key = `${r.ts}|${String(r.from || '')}|${String(r.to || '')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }

      // упорядочим ключи по ts (численно)
      const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
        const ta = Number(a.split('|')[0]) || 0;
        const tb = Number(b.split('|')[0]) || 0;
        return ta - tb;
      });

      const myKey = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();

      for (const key of orderedKeys) {
        const bucket = groups.get(key) || [];
        // предпочитаем локальную копию, если есть
        let preferred = bucket.find(x => x.meta && x.meta.localCopy) || bucket[0];

        // если preferred дешифровка не удалась, но в бакете есть локальная — попробуем её
        let textForUI = '';
        let decrypted = false;

        if (preferred && preferred.encrypted) {
          try {
            const plain = await decryptOwn(preferred.text);
            textForUI = plain;
            decrypted = true;
            console.log('[chat] decrypted history msg ts=', preferred.ts, 'from=', preferred.from, '->', String(plain).slice(0, 120));
          } catch (e) {
            console.warn('[chat] decrypt failed for preferred record ts=', preferred.ts, preferred.from, e && e.message ? e.message : e);
            // попробуем найти альтернативную запись в той же группе (например локальную), если не выбранная
            const alt = bucket.find(x => x !== preferred && x.encrypted && x.meta && x.meta.localCopy);
            if (alt) {
              try {
                const plain2 = await decryptOwn(alt.text);
                textForUI = plain2;
                decrypted = true;
                console.log('[chat] decrypted alternative history msg ts=', alt.ts, 'from=', alt.from);
              } catch (ee) {
                // не удалось и там
                console.warn('[chat] alt decrypt also failed', ee && ee.message ? ee.message : ee);
              }
            }
          }
        } else if (preferred) {
          // plaintext stored
          textForUI = String(preferred.text || '');
          decrypted = true;
        }

        if (!decrypted) {
          textForUI = '[Зашифровано]';
          // Доп.диагностика: если это входящее к нам сообщение и decryptOwn не удался,
          // проверим соответствие нашего локального pubkey и серверного pubkey (чтобы понять, не сменился ли ключ)
          try {
            if (String(preferred.to || '').toLowerCase() === myKey) {
              // получим serverPub для myKey
              const serverPub = await fetchAndCachePubkey(myKey); // пробуем получить и кешировать
              const localKeys = await getLocalKeypair();
              const localPub = localKeys && localKeys.publicKeyBase64 ? localKeys.publicKeyBase64 : null;
              if (serverPub && localPub && serverPub !== localPub) {
                console.warn('[chat] local public key differs from server public key — historical decryption impossible for messages encrypted to server key');
                showInAppToast('Ключи изменены: Ваш локальный ключ не совпадает с серверным — старые сообщения не расшифруются.');
              }
            }
          } catch (diagE) {
            console.warn('[chat] diagnostic check failed', diagE);
          }
        }

        const outgoing = String(preferred.from || '').toLowerCase() === myKey;
        const deliveryFlag = preferred && preferred.meta && preferred.meta.delivery ? preferred.meta.delivery : undefined;
        state.currentChat.messages.push({
          outgoing: !!outgoing,
          text: textForUI,
          ts: preferred.ts || Date.now(),
          delivery: deliveryFlag
        });
      }

      // После загрузки истории покажем сообщения
      renderMessages();

    } catch (e) {
      console.error('[chat] failed to load history for', normalized, e && (e.stack || e));
    } finally {
      // фокус на input
      setTimeout(() => {
        const inp = document.getElementById('chatInput');
        if (inp) inp.focus();
      }, 50);
    }
  })();
}

// закрыть чат
function closeChat() {
  const overlay = document.getElementById('chatOverlay');
  if (overlay) overlay.style.display = 'none';
  state.currentChat = null;
  state.currentOpenChatUserKey = null;
}

// рендер сообщений
function renderMessages() {
  const out = document.getElementById('chatMessages');
  if (!out) return;
  // очищаем
  while (out.firstChild) out.removeChild(out.firstChild);
  if (!state.currentChat || !Array.isArray(state.currentChat.messages)) return;

  let lastTs = null;

  state.currentChat.messages.forEach(m => {
    const ts = (m.meta && m.meta.origTs) || m.ts || m.meta.localTs || Date.now();

    // вставляем разделитель даты если дата изменилась
    if (!lastTs || !isSameDay(lastTs, ts)) {
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.textContent = formatDateHeader(ts);
      out.appendChild(sep);
    }

    // оболочка ряда (для flex-выравнивания)
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.classList.add(m.outgoing ? 'outgoing' : 'incoming');

    // пузырь
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    // текст
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = m.text || '';

    // meta (время и, при необходимости, иконки статуса)
    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = formatTimeOnly(ts);

    // галочка
    const tick = document.createElement('span');
    tick.className = 'msg-tick';
    if (m.outgoing) {
      // m.delivery может быть 'pending'|'sent'|'read'|'failed'
      if (m.delivery === 'pending' || !m.delivery) tick.textContent = '⏳';
      else if (m.delivery === 'delivered' || m.delivery === 'sent') tick.textContent = '✔';
      else if (m.delivery === 'read') tick.textContent = '✔✔';
      else if (m.delivery === 'failed') tick.textContent = '❗';

      meta.appendChild(tick);
    }

    meta.appendChild(timeEl);

    bubble.appendChild(textEl);
    bubble.appendChild(meta);
    row.appendChild(bubble);
    out.appendChild(row);

    lastTs = ts;
  });

  // прокрутка вниз
  out.scrollTop = out.scrollHeight;
}

// отправка сообщения
async function sendChatMessage() {
  const inp = document.getElementById('chatInput');
  if (!inp || !state.currentChat) return;
  const text = (inp.value || '').trim();
  if (!text) return;
  if (text.length > 2000) { alert('Сообщение слишком длинное'); return; }

  if (!state.presenceClient) {
    console.warn('state.presenceClient not set; cannot send message');
    showInAppToast('Ошибка: Отправка невозможна: не подключён state.presenceClient');
    return;
  }

  try {
    const recipient = state.currentChat.userKey;
    // используем userKey (нормализованный) как "me"
    const me = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();

    console.log('[send] preparing to send to=', recipient, 'textPreview=', text.slice(0, 50));

    // получаем публичный ключ получателя (кеш/сервер)
    const pubRecipient = await getPubkey(recipient);
    if (!pubRecipient) {
      console.error('[send] no public key for', recipient);
      showInAppToast('Ошибка: Публичный ключ получателя не найден, отправка отменена');
      return;
    }

    // получаем локальную пару (чтобы получить наш публичный ключ)
    const localKeys = await getLocalKeypair();
    if (!localKeys || !localKeys.publicKeyBase64) {
      console.error('[send] no local sodium keypair present');
      showInAppToast('Ошибка: Локальная пара ключей не найдена, попытайтесь повторно авторизоваться');
      return;
    }
    const myPubB64 = localKeys.publicKeyBase64;

    // шифруем два варианта:
    //    - тот, что уйдёт получателю (зашифрован на recipient pub)
    //    - локальная копия, зашифрованная на ваш собственный публичный ключ (для локального хранения)
    const cipherForRecipient = await encryptForPublicBase64(pubRecipient, text);
    const cipherForMe = await encryptForPublicBase64(myPubB64, text);

    const ts = Date.now();

    // сохраним локальную копию (priority) — зашифрованную для нас (чтобы decryptOwn работал после рестарта)
    try {
      await saveMessageLocal({
        from: me,
        to: recipient,
        text: cipherForMe,
        encrypted: true,
        ts,
        meta: { localCopy: true, sentByMe: true, delivery: 'pending' },
        read: true,
      });
      console.log('[send] saved local encrypted copy to IDB (sentByMe)', { to: recipient, ts });
    } catch (e) {
      console.warn('[send] failed to save local encrypted copy to IDB', e && e.message ? e.message : e);
    }

    // отрисовываем plaintext локально (пользователь должен увидеть своё сообщение сразу)
    state.currentChat.messages.push({ outgoing: true, text, ts, delivery: 'pending' });
    renderMessages();
    inp.value = '';

    let sent = false;

    // отправляем через state.presenceClient (payload содержит зашифрованный для получателя текст)
    try {
      const payload = { type: 'chat_message', encrypted: true, text: cipherForRecipient, ts };
      sent = state.presenceClient.sendSignal(recipient, payload);
      console.log('[send] state.presenceClient.sendSignal returned', sent, 'recipient=', recipient);
    } catch (e) {
      console.error('[send] state.presenceClient.sendSignal threw', e && e.stack ? e.stack : e);
    }


    // Не меняем status на 'sent' сразу после sendSignal — ждём реального receipt от получателя.
    // Но логируем состояние отправки на сервер
    if (sent) {
      console.log('[send] message accepted by server/ws (still waiting for delivery receipt)');
    } else {
      console.log('[send] message queued locally (no active WS). Will be sent when connection restores');
      // (опционально) можно показать пользователю toast о том, что сообщение в очереди
    }

    // UI уже показывает 'pending' (⏳). renderMessages() ниже обновит вид.
    renderMessages();
  } catch (e) {
    console.error('[send] failed', e && (e.stack || e));
    showInAppToast('Ошибка: Не удалось отправить сообщение');
  }
}

// для получения входящих сообщений из auth.js (presence listener) 
export async function handleIncomingMessage(fromUserKey, payload) {
  try {
    if (!payload) return false;
    const from = String(fromUserKey || '').toLowerCase();

    if (payload.type === 'chat_receipt') {
      // (существующая логика — без изменений, оставлена для контекста)
      const ts = payload.ts;
      const status = payload.status; // ожидаем 'delivered'|'read'|'failed'

      if (state.currentChat && state.currentChat.userKey === from) {
        for (let i = state.currentChat.messages.length - 1; i >= 0; i--) {
          const m = state.currentChat.messages[i];
          if (m.outgoing && Number(m.ts) === Number(ts)) {
            if (status === 'read') m.delivery = 'read';
            else if (status === 'delivered') m.delivery = 'delivered';
            else m.delivery = status || m.delivery;
            break;
          }
        }
        renderMessages();
      }

      try {
        const res = await updateMessageDeliveryStatus(from, ts, status === 'read' ? 'read' : (status === 'delivered' ? 'delivered' : status));
        console.log('[incoming][receipt] from=', from, 'ts=', ts, 'status=', status, 'updateMessageDeliveryStatus result:', res);
      } catch (e) {
        console.warn('[incoming][receipt] updateMessageDeliveryStatus threw', e);
      }
      return true;
    }

    // Обработка входящего chat_message
    if (!payload || payload.type !== 'chat_message') return false;

    const me = (localStorage.getItem('pwaUserName') || '').trim();
    const shouldMarkRead = !!(state.currentChat && state.currentChat.userKey === from);

    // сохраняем и дождёмся записи
    try {
      await saveMessageLocal({
        from,
        to: me,
        text: payload.encrypted ? payload.text : String(payload.text || ''),
        encrypted: !!payload.encrypted,
        ts: payload.ts || Date.now(),
        meta: { deliveredVia: 'ws' },
        read: shouldMarkRead
      });
    } catch (e) {
      console.warn('[incoming] failed to save message to IDB', e);
    }

    // Если чат открыт — отрисуем (и отправим read receipt)
    if (state.currentChat && state.currentChat.userKey === from) {
      (async () => {
        try {
          const messageTs = payload.ts || Date.now();
          if (payload.encrypted) {
            try {
              const plain = await decryptOwn(payload.text);
              state.currentChat.messages.push({ outgoing: false, text: plain, ts: messageTs });
            } catch (e) {
              state.currentChat.messages.push({ outgoing: false, text: '[Зашифровано]', ts: messageTs });
            }
          } else {
            state.currentChat.messages.push({ outgoing: false, text: String(payload.text || ''), ts: messageTs });
          }

          renderMessages();

          // Отправляем read receipt немедленно — т.к. чат открыт и сообщение показано пользователю.
          try {
            if (state.presenceClient && typeof state.presenceClient.sendSignal === 'function') {
              const receiptPayload = { type: 'chat_receipt', ts: messageTs, status: 'read' };
              const ok = state.presenceClient.sendSignal(from, receiptPayload);
              console.log('[incoming][receipt] sent read for open chat', { to: from, ts: messageTs, ok });
            } else {
              console.warn('[incoming][receipt] no state.presenceClient to send read for open chat', { to: from, ts: messageTs });
            }
          } catch (e) {
            console.warn('[incoming][receipt] failed sending read for open chat', e && e.message ? e.message : e);
          }

        } catch (e) { console.error(e); }
      })();
      return true;
    }

    // чат закрыт — уже существующая логика: обновим бейдж и отправим delivered receipt
    try {
      await updateUnreadBadge(from);
      const row = document.querySelector(`.user-row[data-userkey="${from}"]`);
      if (row) {
        row.style.borderLeft = '4px solid #0b93f6';
        setTimeout(() => { try { row.style.borderLeft = ''; } catch (e) { } }, 3500);
      }
    } catch (e) {
      console.warn('[incoming] updateUnreadBadge failed', e);
    }

    try {
      if (state.presenceClient && typeof state.presenceClient.sendSignal === 'function') {
        const receiptStatus = shouldMarkRead ? 'read' : 'delivered'; // если чат открыт — read, иначе delivered
        try {
          const receiptPayload = { type: 'chat_receipt', ts: payload.ts, status: receiptStatus };
          state.presenceClient.sendSignal(from, receiptPayload);
          console.log('[receipt] sent', receiptPayload, 'to', from);
        } catch (e) {
          console.warn('[receipt] failed to send receipt', e && e.message ? e.message : e);
        }
      }
    } catch (e) { /* ignore */ }

    return false;
  } catch (e) {
    console.error('[incoming] handler error', e && (e.stack || e));
    return false;
  }
}

// безопасно очистить элемент
export function clearElement(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

// безопасно показать message в блоке resultBlock
export function showResultBlock(resultBlock, lines, hideAfterMs) {
  if (!resultBlock) return;
  clearElement(resultBlock);
  lines.forEach(l => {
    if (typeof l === 'string') {
      const d = document.createElement('div');
      d.textContent = l;
      resultBlock.appendChild(d);
    } else {
      resultBlock.appendChild(l);
    }
  });
  if (hideAfterMs) {
    setTimeout(() => { try { resultBlock.style.display = 'none'; } catch (e) { } }, hideAfterMs);
  }
}

// Инициализатор обработчика postMessage от service-worker
export function initSWMessageHandler() {
  if (!('serviceWorker' in navigator)) return;

  // обработчик сообщений от service-worker
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const msg = ev && ev.data;
    if (!msg) return;

    try {
      if (msg.type === 'push') {
        // осторожно извлекаем payload — сервер/пуш может иметь разные формы
        const payload = msg.data || {};
        handleSWPush(payload);
        return;
      }

      if (msg.type === 'open_chat') {
        const from = msg.from || (msg.data && msg.data.from) || null;
        if (!from) return;
        // делегируем открытие чата через глобальное событие (совместимо с текущей логикой)
        document.dispatchEvent(new CustomEvent('open_chat', { detail: { from } }));
        return;
      }
    } catch (e) {
      console.error('[SW->client] message handler failed', e && (e.stack || e));
    }
  }, { passive: true });
}

// Обработать push-перенесённый из service-worker
async function handleSWPush(payload) {
  try {
    // Попробуем извлечь поле from
    const from =
      (payload && payload.data && payload.data.from) ||
      (payload && payload.from) ||
      (payload && payload.data && payload.data.sender) ||
      null;

    // Сформируем snippet для бейджа/всплывашки:
    // сервер может положить полезные данные в payload.data.payload
    let snippet = '';
    try {
      if (payload && payload.data && payload.data.payload) {
        const inner = payload.data.payload;
        // inner может содержать { text, encrypted }
        if (inner.encrypted) snippet = '[Зашифровано]';
        else snippet = inner.text || payload.body || '';
      } else {
        // fallback: используем payload.body или payload.text
        if (payload && typeof payload.body === 'string' && payload.body.length > 0) snippet = payload.body;
        else if (payload && typeof payload.text === 'string' && payload.text.length > 0) snippet = payload.text;
        else snippet = '[Новое сообщение]';
      }
    } catch (e) {
      snippet = '[Новое сообщение]';
    }

    // Если нет from — просто покажем in-app toast, но не будем пытаться привязать к user-row
    if (!from) {
      try { showInAppToast('Новое сообщение', {}); } catch (e) { console.warn('[SW] showInAppToast failed', e); }
      return;
    }

    const normFrom = String(from).toLowerCase();

    // Если чат открыт — НЕ показываем бейдж/тотальную нотификацию (в UI уже отображается)
    if (isChatOpenWith(normFrom)) {
      // если открыт — можно обновить историю (если требуется) — но пока просто логируем
      console.log('[SW->client] push for open chat ignored (already open):', normFrom);
      return;
    }

    try {
      // ждем обновления бейджа на основе IDB
      await updateUnreadBadge(normFrom);
    } catch (e) {
      console.warn('[SW->client] updateBadge failed', e);
    }

    // Показываем в-app toast (коротко)
    try {
      // красиво форматируем displayName если есть (пока — просто ucfirst)
      const label = String(normFrom).length > 0 ? (normFrom.charAt(0).toUpperCase() + normFrom.slice(1)) : 'Пользователь';
      showInAppToast(`Новое сообщение от ${label}`, { from: normFrom });
    } catch (e) {
      console.warn('[SW->client] showInAppToast failed', e);
    }

    // Если у нас есть state.presenceClient и в push-полезных данных есть оригинальный ts — подтвердим доставку
    try {
      const inner = (payload && payload.data && payload.data.payload) || null;
      const origTs = inner && (inner.ts || inner.messageTs || inner.t) ? (inner.ts || inner.messageTs || inner.t) : null;

      // Если чат открыт и видим — считаем прочитаным
      const shouldMarkRead = isChatOpenWith(normFrom);

      if (state.presenceClient && typeof state.presenceClient.sendSignal === 'function' && origTs) {
        const receiptStatus = shouldMarkRead ? 'read' : 'delivered';
        try {
          const receiptPayload = { type: 'chat_receipt', ts: origTs, status: receiptStatus };
          state.presenceClient.sendSignal(normFrom, receiptPayload);
          console.log('[SW->client receipt] sent', receiptPayload, 'to', normFrom);
        } catch (e) {
          console.warn('[SW->client] failed to send receipt', e);
        }
      }
    } catch (e) {
      console.warn('[SW->client] receipt send attempt failed', e);
    }
  } catch (e) {
    console.error('[SW->client] handleSWPush fatal', e && (e.stack || e));
  }
}

document.addEventListener('open_chat', (e) => {
  const from = e.detail && e.detail.from;
  if (!from) return;
  // найди displayName в списке пользователей или используем userKey
  const row = document.querySelector(`.user-row[data-userkey="${from}"]`);
  const displayName = row ? (row.querySelector('div').textContent || from) : from;
  openChatForUser({ userKey: from, displayName });
});
