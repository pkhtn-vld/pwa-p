import {
  getPubkey,
  encryptForPublicBase64,
  decryptOwn,
  saveMessageLocal,
  getMessagesWith,
  cachePubkey,
  getLocalKeypair,
  fetchAndCachePubkey
} from './cryptoSodium.js';

let presenceClient = null;
let currentChat = null; // { userKey, displayName, messages: [] }
let onlineSet = new Set();
let currentOpenChatUserKey = null;

// экспорт функции проверки
export function isChatOpenWith(userKey) {
  if (!userKey) return false;
  return String(currentOpenChatUserKey || '').toLowerCase() === String(userKey || '').toLowerCase();
}

// Простейший in-app toast (замените на ваш компонент/стиль)
export function showInAppToast(title, body, meta = {}) {
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
    el.textContent = `${title}: ${body}`;
    el.style.display = 'block';
    // исчезает через 4 сек
    setTimeout(() => { try { el.style.display = 'none'; } catch (e) { } }, 4000);
  } catch (e) {
    console.log('toast fallback', title, body);
  }
}

export function setPresenceClient(pc) {
  presenceClient = pc;
}

// экспорт функции обновления статусов
export function updateOnlineList(onlineArray) {
  onlineSet = new Set((onlineArray || []).map(x => String(x).toLowerCase()));
  const container = document.getElementById('userList');
  if (!container) return;
  const rows = container.querySelectorAll('.user-row');
  rows.forEach(row => {
    const userKey = row.getAttribute('data-userkey') || '';
    const dot = row.querySelector('.status-dot');
    if (dot) {
      dot.style.color = onlineSet.has(userKey.toLowerCase()) ? '#28a745' : '#9AA0A6';
    }
  });

  // Если открыт чат — обновим статус в заголовке чата (если совпадает)
  if (currentChat && currentChat.userKey) {
    updateChatStatusDot(currentChat.userKey);
  }
}

// для обновления точки в заголовке чата
function updateChatStatusDot(userKey) {
  try {
    if (!userKey) return;
    const dot = document.getElementById('chatStatusDot');
    if (!dot) return;
    const isOnline = onlineSet.has(String(userKey).toLowerCase());
    dot.style.color = isOnline ? '#28a745' : '#9AA0A6';
    dot.title = isOnline ? 'онлайн' : 'оффлайн';
  } catch (e) { /* silent */ }
}

function createTopBarIfMissing() {
  let top = document.getElementById('topBar');
  if (top) return top;

  top = document.createElement('div');
  top.id = 'topBar';
  // Базовые стили — можно вынести в CSS
  top.style.position = 'sticky';
  top.style.top = '0';
  top.style.left = '0';
  top.style.width = '100%';
  top.style.display = 'flex';
  top.style.alignItems = 'center';
  top.style.justifyContent = 'space-between';
  top.style.padding = '8px 12px';
  top.style.boxSizing = 'border-box';
  top.style.background = '#fafafa';
  top.style.borderBottom = '1px solid #e6e6e6';
  top.style.zIndex = '1000';

  // left: current user info
  const left = document.createElement('div');
  left.id = 'topBarLeft';
  left.style.display = 'flex';
  left.style.alignItems = 'center';
  left.style.gap = '12px';

  const avatar = document.createElement('div');
  avatar.id = 'topBarAvatar';
  avatar.style.width = '36px';
  avatar.style.height = '36px';
  avatar.style.borderRadius = '50%';
  avatar.style.background = '#eaeaea';
  avatar.style.display = 'flex';
  avatar.style.alignItems = 'center';
  avatar.style.justifyContent = 'center';
  avatar.style.fontWeight = '600';
  avatar.style.color = '#555';
  avatar.textContent = '?';

  const nameEl = document.createElement('div');
  nameEl.id = 'topBarName';
  nameEl.style.fontSize = '16px';
  nameEl.style.fontWeight = '600';
  nameEl.textContent = 'Гость';

  const statusEl = document.createElement('div');
  statusEl.id = 'topBarStatus';
  statusEl.style.fontSize = '12px';
  statusEl.style.color = '#666';
  statusEl.textContent = 'offline';

  const leftWrap = document.createElement('div');
  leftWrap.style.display = 'flex';
  leftWrap.style.flexDirection = 'column';
  leftWrap.appendChild(nameEl);
  leftWrap.appendChild(statusEl);

  left.appendChild(avatar);
  left.appendChild(leftWrap);

  // right: profile/settings icon
  const right = document.createElement('div');
  right.id = 'topBarRight';
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = '12px';

  const settingsBtn = document.createElement('button');
  settingsBtn.title = 'Настройки профиля';
  settingsBtn.id = 'settings-btn';
  settingsBtn.textContent = '⚙️';
  settingsBtn.addEventListener('click', () => { alert('Настройки профиля.'); });

  right.appendChild(settingsBtn);

  top.appendChild(left);
  top.appendChild(right);

  // вставляем в body в начало
  document.body.insertBefore(top, document.body.firstChild);
  return top;
}

// Устанавливает текст и аватар в верхней полосе
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
    // базовые стили контейнера (можно выносить в CSS)
    container.style.width = '100%';
    container.style.boxSizing = 'border-box';
    container.style.padding = '0';
    container.style.marginTop = '0';
    container.style.background = '#f8f8f8';
    container.style.flex = '1';
    container.style.overflowY = 'auto';
    // вставим перед footer или в конец body
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
    userDiv.style.display = 'flex';
    userDiv.style.alignItems = 'center';
    userDiv.style.justifyContent = 'space-between';
    userDiv.style.width = '100%';
    userDiv.style.boxSizing = 'border-box';
    userDiv.style.padding = '12px 16px';
    userDiv.style.borderBottom = '1px solid #eee';
    userDiv.style.background = '#fff';

    // left: имя пользователя
    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '12px';

    // аватар-плейсхолдер (круг)
    const avatar = document.createElement('div');
    avatar.style.width = '40px';
    avatar.style.height = '40px';
    avatar.style.borderRadius = '50%';
    avatar.style.background = '#f0f0f0';
    avatar.style.display = 'flex';
    avatar.style.alignItems = 'center';
    avatar.style.justifyContent = 'center';
    avatar.style.fontWeight = '600';
    avatar.style.color = '#666';
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
    statusBtn.title = 'Статус активности';
    statusBtn.style.border = 'none';
    statusBtn.style.background = 'transparent';
    statusBtn.style.cursor = 'pointer';
    statusBtn.style.fontSize = '18px';
    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot';
    statusDot.textContent = '●';
    statusDot.style.color = (u.online ? '#28a745' : '#9AA0A6');
    statusDot.style.fontSize = '16px';
    statusBtn.appendChild(statusDot);

    // иконка сообщения
    const msgBtn = document.createElement('button');
    msgBtn.title = 'Написать сообщение';
    msgBtn.style.border = 'none';
    msgBtn.style.background = 'transparent';
    msgBtn.style.cursor = 'pointer';
    msgBtn.style.fontSize = '18px';
    msgBtn.textContent = '✉️';
    msgBtn.addEventListener('click', () => {
      openChatForUser({ userKey: userKeyNorm, displayName: u.displayName || userKeyNorm });
    });

    // иконка звонка
    const callBtn = document.createElement('button');
    callBtn.title = 'Позвонить';
    callBtn.style.border = 'none';
    callBtn.style.background = 'transparent';
    callBtn.style.cursor = 'pointer';
    callBtn.style.fontSize = '18px';
    callBtn.textContent = '📞';
    callBtn.addEventListener('click', () => {
      alert('Инициация звонка пользователю: ' + (u.displayName || userKeyNorm));
    });

    // элемент бейджа непрочитанных
    const unreadBadge = document.createElement('span');
    unreadBadge.className = 'unread-badge';
    unreadBadge.style.display = 'none';
    unreadBadge.style.background = '#0b93f6';
    unreadBadge.style.color = '#fff';
    unreadBadge.style.borderRadius = '10px';
    unreadBadge.style.padding = '2px 6px';
    unreadBadge.style.fontSize = '12px';
    unreadBadge.style.marginLeft = '8px';
    unreadBadge.textContent = '●';

    right.appendChild(statusBtn);
    right.appendChild(msgBtn);
    right.appendChild(callBtn);
    right.appendChild(unreadBadge);

    userDiv.appendChild(left);
    userDiv.appendChild(right);

    container.appendChild(userDiv);
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
    } else {
      // неожиданный формат
    }
  } catch (err) {
    console.error('Ошибка при загрузке пользователей:', err);
  }
}

// function escapeHtml(str) {
//   if (!str) return '';
//   return String(str).replace(/[&<>"'`=\/]/g, function (s) {
//     return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;' })[s];
//   });
// }

// Chat UI
function createChatOverlay() {
  if (document.getElementById('chatOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'chatOverlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.flexDirection = 'column';
  overlay.style.background = '#fff';
  overlay.style.zIndex = '2000';
  overlay.style.display = 'none';

  const top = document.createElement('div');
  top.id = 'chatTop';
  top.style.display = 'flex';
  top.style.alignItems = 'center';
  top.style.justifyContent = 'space-between';
  top.style.padding = '10px';
  top.style.boxShadow = '0 1px 0 rgba(0,0,0,0.06)';

  const back = document.createElement('button');
  back.textContent = '←';
  back.id = 'chat-back-btn';
  back.addEventListener('click', closeChat);

  const titleWrap = document.createElement('div');
  titleWrap.style.display = 'flex';
  titleWrap.style.alignItems = 'center';
  titleWrap.style.gap = '8px';

  const title = document.createElement('div');
  title.id = 'chatTitle';
  title.style.fontWeight = '600';
  title.style.fontSize = '16px';

  // статусная точка в заголовке
  const statusDot = document.createElement('span');
  statusDot.id = 'chatStatusDot';
  statusDot.textContent = '●';
  statusDot.style.fontSize = '14px';
  statusDot.style.color = '#9AA0A6';
  statusDot.style.lineHeight = '1';
  statusDot.title = 'оффлайн';

  titleWrap.appendChild(statusDot);
  titleWrap.appendChild(title);

  const right = document.createElement('div');
  right.style.width = '36px';
  top.appendChild(back);
  top.appendChild(titleWrap);
  top.appendChild(right);

  const messages = document.createElement('div');
  messages.id = 'chatMessages';
  messages.style.flex = '1';
  messages.style.overflowY = 'auto';
  messages.style.padding = '12px';
  messages.style.display = 'flex';
  messages.style.flexDirection = 'column';
  messages.style.gap = '8px';
  messages.style.background = '#f7f7f7';

  const inputWrap = document.createElement('div');
  inputWrap.style.display = 'flex';
  inputWrap.style.padding = '8px';
  inputWrap.style.boxSizing = 'border-box';
  inputWrap.style.gap = '8px';
  inputWrap.style.alignItems = 'center';
  inputWrap.style.borderTop = '1px solid #eee';

  const input = document.createElement('input');
  input.id = 'chatInput';
  input.type = 'text';
  input.placeholder = 'Написать сообщение';
  input.style.flex = '1';
  input.style.padding = '10px';
  input.style.border = '1px solid #ddd';
  input.style.borderRadius = '20px';
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      try {
        // дизейблим кнопку чтобы не нажимали несколько раз
        sendBtn.disabled = true;
        await sendChatMessage();
      } catch (err) {
        console.error('[UI] sendChatMessage error', err && (err.stack || err));
        showInAppToast('Ошибка', 'Не удалось отправить сообщение');
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
      showInAppToast('Ошибка', 'Не удалось отправить сообщение');
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

// Экспортируем openChatForUser для вызовов извне
export function openChatForUser({ userKey, displayName }) {
  currentOpenChatUserKey = String(userKey || '').toLowerCase();
  createChatOverlay();
  const normalized = (userKey || '').toString().toLowerCase();
  currentChat = { userKey: normalized, displayName: displayName || userKey, messages: [] };

  // загрузим непрочитанные сообщения из localStorage, если есть
  try {
    const key = 'unread_' + normalized;
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(prev) && prev.length > 0) {
      prev.forEach(m => currentChat.messages.push({ outgoing: false, text: m.text, ts: m.ts || Date.now() }));
      localStorage.removeItem(key);
    }
    // прячем бейдж в списке
    const row = document.querySelector(`.user-row[data-userkey="${normalized}"]`);
    if (row) {
      const badge = row.querySelector('.unread-badge');
      if (badge) badge.style.display = 'none';
    }
  } catch (e) { }

  document.getElementById('chatOverlay').style.display = 'flex';
  document.getElementById('chatTitle').textContent = currentChat.displayName;

  // обновим статусную точку
  updateChatStatusDot(currentChat.userKey);

  renderMessages();

    // Асинхронно: загрузим историю из IndexedDB и подставим в currentChat.messages
  (async () => {
    try {
      console.log('[chat] loading history for', normalized);
      const rows = await getMessagesWith(normalized); // отсортировано по ts
      currentChat.messages = []; // заменим текущий буфер на содержимое IDB

      // сгруппируем записи по key = `${ts}|${from}|${to}`
      const groups = new Map();
      for (const r of rows) {
        const key = `${r.ts}|${String(r.from||'')}|${String(r.to||'')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }

      // упорядочим ключи по ts (численно)
      const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
        const ta = Number(a.split('|')[0]) || 0;
        const tb = Number(b.split('|')[0]) || 0;
        return ta - tb;
      });

      const myKey = (localStorage.getItem('pwaUserKey') || '').trim().toLowerCase();

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
            console.log('[chat] decrypted history msg ts=', preferred.ts, 'from=', preferred.from, '->', String(plain).slice(0,120));
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
                showInAppToast('Ключи изменены', 'Ваш локальный ключ не совпадает с серверным — старые сообщения не расшифруются.');
              }
            }
          } catch (diagE) {
            console.warn('[chat] diagnostic check failed', diagE);
          }
        }

        const outgoing = String(preferred.from || '').toLowerCase() === myKey;
        currentChat.messages.push({ outgoing: !!outgoing, text: textForUI, ts: preferred.ts || Date.now() });
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

function closeChat() {
  const overlay = document.getElementById('chatOverlay');
  if (overlay) overlay.style.display = 'none';
  currentChat = null;
}

function renderMessages() {
  const out = document.getElementById('chatMessages');
  if (!out) return;
  // используем безопасное очищение
  while (out.firstChild) out.removeChild(out.firstChild);
  if (!currentChat) return;
  currentChat.messages.forEach(m => {
    const row = document.createElement('div');
    row.style.maxWidth = '80%';
    row.style.padding = '8px 10px';
    row.style.borderRadius = '12px';
    row.style.wordBreak = 'break-word';
    if (m.outgoing) {
      row.style.alignSelf = 'flex-end';
      row.style.background = '#0b93f6';
      row.style.color = '#fff';
      row.style.borderBottomRightRadius = '4px';
    } else {
      row.style.alignSelf = 'flex-start';
      row.style.background = '#fff';
      row.style.color = '#111';
      row.style.borderBottomLeftRadius = '4px';
    }
    row.textContent = m.text || '';
    out.appendChild(row);
  });
  out.scrollTop = out.scrollHeight;
}

async function sendChatMessage() {
  const inp = document.getElementById('chatInput');
  if (!inp || !currentChat) return;
  const text = (inp.value || '').trim();
  if (!text) return;
  if (text.length > 2000) { alert('Сообщение слишком длинное'); return; }

  if (!presenceClient) {
    console.warn('presenceClient not set; cannot send message');
    showInAppToast('Ошибка', 'Отправка невозможна: не подключён presenceClient');
    return;
  }

  try {
    const recipient = currentChat.userKey;
    // используем userKey (нормализованный) как "me"
    const me = (localStorage.getItem('pwaUserKey') || '').trim().toLowerCase();

    console.log('[send] preparing to send to=', recipient, 'textPreview=', text.slice(0,50));

    // получаем публичный ключ получателя (кеш/сервер)
    const pubRecipient = await getPubkey(recipient);
    if (!pubRecipient) {
      console.error('[send] no public key for', recipient);
      showInAppToast('Ошибка', 'Публичный ключ получателя не найден, отправка отменена');
      return;
    }

    // получаем локальную пару (чтобы получить наш публичный ключ)
    const localKeys = await getLocalKeypair();
    if (!localKeys || !localKeys.publicKeyBase64) {
      console.error('[send] no local sodium keypair present');
      showInAppToast('Ошибка', 'Локальная пара ключей не найдена, попытайтесь повторно авторизоваться');
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
        meta: { localCopy: true, sentByMe: true }
      });
      console.log('[send] saved local encrypted copy to IDB (sentByMe)', { to: recipient, ts });
    } catch (e) {
      console.warn('[send] failed to save local encrypted copy to IDB', e && e.message ? e.message : e);
    }

    // опционально: сохраним также копию, зашифрованную для получателя (remote copy)
    //    Это может быть полезно для синхронизации/бэкапа. Флаг meta.remoteCopy отличает её.
    // try {
    //   await saveMessageLocal({
    //     from: me,
    //     to: recipient,
    //     text: cipherForRecipient,
    //     encrypted: true,
    //     ts,
    //     meta: { remoteCopy: true, sentByMe: true }
    //   });
    //   console.log('[send] saved remote encrypted copy to IDB (for sync)', { to: recipient, ts });
    // } catch (e) {
    //   console.warn('[send] failed to save remote encrypted copy to IDB', e && e.message ? e.message : e);
    // }

    // отрисовываем plaintext локально (пользователь должен увидеть своё сообщение сразу)
    currentChat.messages.push({ outgoing: true, text, ts });
    renderMessages();
    inp.value = '';

    // отправляем через presenceClient (payload содержит зашифрованный для получателя текст)
    try {
      const payload = { type: 'chat_message', encrypted: true, text: cipherForRecipient, ts };
      const sent = presenceClient.sendSignal(recipient, payload);
      console.log('[send] presenceClient.sendSignal returned', sent, 'recipient=', recipient);
    } catch (e) {
      console.error('[send] presenceClient.sendSignal threw', e && e.stack ? e.stack : e);
    }
  } catch (e) {
    console.error('[send] failed', e && (e.stack || e));
    showInAppToast('Ошибка', 'Не удалось отправить сообщение');
  }
}

// для получения входящих сообщений из auth.js (presence listener) 
export function handleIncomingMessage(fromUserKey, payload) {
  try {
    if (!payload || payload.type !== 'chat_message') return false;
    const from = String(fromUserKey || '').toLowerCase();

    // лог приходящего сообщения (обрезаем длинную строку для читаемости)
    try {
      console.log('[incoming] received from=', from, 'payloadPreview=', JSON.stringify(payload).slice(0,300));
    } catch (e) { console.log('[incoming] received from=', from); }

    const me = (localStorage.getItem('pwaUserName') || '').trim();

    // если сообщение зашифровано - асинхронно сохраним зашифрованный вариант
    if (payload.encrypted) {
      // стартуем асинхронное сохранение (не await'им)
      (async () => {
        try {
          await saveMessageLocal({ from, to: me, text: payload.text, encrypted: true, ts: payload.ts || Date.now(), meta: { deliveredVia: 'ws' } });
          console.log('[incoming] saved encrypted message to IDB (from=', from, ')');
        } catch (e) {
          console.warn('[incoming] failed to save encrypted message to IDB', e && e.message ? e.message : e);
        }
      })();
    } else {
      // plaintext: сохраняем тоже (compat)
      (async () => {
        try {
          await saveMessageLocal({ from, to: me, text: String(payload.text || ''), encrypted: false, ts: payload.ts || Date.now(), meta: { deliveredVia: 'ws' } });
          console.log('[incoming] saved plaintext message to IDB (from=', from, ')');
        } catch (e) {
          console.warn('[incoming] failed to save plaintext message to IDB', e && e.message ? e.message : e);
        }
      })();
    }

    // Если открыт чат с этим пользователем — попытаемся расшифровать и отобразить.
    if (currentChat && currentChat.userKey === from) {
      // Запускаем async-дефракцию/отрисовку, но возвращаем true немедленно.
      (async () => {
        try {
          if (payload.encrypted) {
            try {
              const plain = await decryptOwn(payload.text);
              console.log('[incoming] decrypted message from', from, '->', String(plain).slice(0,200));
              currentChat.messages.push({ outgoing: false, text: plain, ts: payload.ts || Date.now() });
              renderMessages();
            } catch (e) {
              console.warn('[incoming] decryptOwn failed for message from', from, e && e.message ? e.message : e);
              // оставить отображение заглушки
              currentChat.messages.push({ outgoing: false, text: '[Зашифровано]', ts: payload.ts || Date.now() });
              renderMessages();
            }
          } else {
            // plaintext
            const plain = String(payload.text || '');
            currentChat.messages.push({ outgoing: false, text: plain, ts: payload.ts || Date.now() });
            renderMessages();
            console.log('[incoming] displayed plaintext message from', from);
          }
        } catch (e) {
          console.error('[incoming] async handler failed', e && (e.stack || e));
        }
      })();

      return true; // handled by open chat UI
    }

    // чат закрыт — отметим в списке пользователей и запомним краткую запись (unread) в localStorage
    try {
      const row = document.querySelector(`.user-row[data-userkey="${from}"]`);
      if (row) {
        try {
          const badge = row.querySelector('.unread-badge');
          if (badge) badge.style.display = 'inline-block';
          row.style.borderLeft = '4px solid #0b93f6';
          setTimeout(() => { try { row.style.borderLeft = ''; } catch (e) { } }, 5000);
        } catch (e) { /* ignore */ }
      }
    } catch (e) { }

    // сохраняем в localStorage краткую непрочитанную запись (как раньше)
    try {
      const key = 'unread_' + from;
      const prev = JSON.parse(localStorage.getItem(key) || '[]');
      const snippet = payload.encrypted ? '[Зашифровано]' : String(payload.text || '');
      prev.push({ text: snippet.slice(0, 200), ts: Date.now() });
      localStorage.setItem(key, JSON.stringify(prev));
    } catch (e) { console.warn('[incoming] failed to store unread in localStorage', e); }

    // не отрисовали в UI (чат не открыт)
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


document.addEventListener('open_chat', (e) => {
  ///////
  const from = e.detail && e.detail.from;
  if (!from) return;
  // найди displayName в списке пользователей или используем userKey
  const row = document.querySelector(`.user-row[data-userkey="${from}"]`);
  const displayName = row ? (row.querySelector('div').textContent || from) : from;
  openChatForUser({ userKey: from, displayName });
});
