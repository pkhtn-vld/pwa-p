let presenceClient = null;
let currentChat = null; // { userKey, displayName, messages: [] }
let onlineSet = new Set();

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

// для обновления точки в заголовке чата ----
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

// Устанавливает текст и аватар в верхней полосе.
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
    const userDiv = document.createElement('div');
    userDiv.className = 'user-row';
    userDiv.setAttribute('data-userkey', (u.userKey || '').toString().toLowerCase());
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
      openChatForUser({ userKey: u.userKey, displayName: u.displayName });
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
      alert('Инициация звонка пользователю: ' + u.displayName);
    });

    right.appendChild(statusBtn);
    right.appendChild(msgBtn);
    right.appendChild(callBtn);

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
      fetch('/debug-log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'loadAndRenderUsers-load-users-faled', error: r.status, ts: Date.now() }), keepalive: true }).catch(()=>{});
      try {
        const text = await r.text().catch(()=>null);
        fetch('/debug-log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'loadAndRenderUsers-failed', status: r.status, body: text, ts: Date.now() }), keepalive: true }).catch(()=>{});
      } catch (e) {
        fetch('/debug-log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'loadAndRenderUsers-failed', status: e.message, body: text, ts: Date.now() }), keepalive: true }).catch(()=>{});
      }
      return;
    }
    const data = await r.json().catch(async (e)=> {
      const txt = await r.text().catch(()=>null);
      fetch('/debug-log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'loadAndRenderUsers-json-parse-failed', error: String(e && e.message), text: txt, ts: Date.now() }), keepalive: true }).catch(()=>{});
      return null;
    });
    if (!data) return;
    if (data && Array.isArray(data.users)) {
      renderUserList(data.users);
    } else {
      // неожиданный формат
      fetch('/debug-log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'loadAndRenderUsers-bad-format', resp: data, ts: Date.now() }), keepalive: true }).catch(()=>{});
    }
  } catch (err) {
    console.error('Ошибка при загрузке пользователей:', err);
    try { fetch('/debug-log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'loadAndRenderUsers-exception', error: String(err && (err.message || err)), stack: err && err.stack || null, ts: Date.now() }), keepalive: true }); } catch (e) {}
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"'`=\/]/g, function (s) {
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;' })[s];
  });
}

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
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
    }
  });

  const sendBtn = document.createElement('button');
  sendBtn.id = 'chatSendBtn';
  sendBtn.textContent = '➤';
  sendBtn.addEventListener('click', sendChatMessage);
  inputWrap.appendChild(input);
  inputWrap.appendChild(sendBtn);

  overlay.appendChild(top);
  overlay.appendChild(messages);
  overlay.appendChild(inputWrap);
  document.body.appendChild(overlay);
}

function openChatForUser({ userKey, displayName }) {
  createChatOverlay();
  currentChat = { userKey: (userKey||'').toString().toLowerCase(), displayName: displayName || userKey, messages: [] };
  document.getElementById('chatOverlay').style.display = 'flex';
  document.getElementById('chatTitle').textContent = currentChat.displayName;

  // обновим статусную точку
  updateChatStatusDot(currentChat.userKey);

  renderMessages();
  setTimeout(() => {
    const inp = document.getElementById('chatInput');
    if (inp) inp.focus();
  }, 50);
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
    // row.innerHTML = escapeHtml(m.text);
    row.textContent = m.text || '';
    out.appendChild(row);
  });
  out.scrollTop = out.scrollHeight;
}

function sendChatMessage() {
  const inp = document.getElementById('chatInput');
  if (!inp || !currentChat) return;
  const text = (inp.value || '').trim();
  if (!text) return;
  if (text.length > 2000) { alert('Сообщение слишком длинное'); return; }
  const payload = { type: 'chat_message', text: text, ts: Date.now() };
  currentChat.messages.push({ outgoing: true, text, ts: payload.ts });
  renderMessages();
  inp.value = '';
  if (!presenceClient) {
    console.warn('presenceClient not set; cannot send message');
    return;
  }
  try {
    presenceClient.sendSignal(currentChat.userKey, payload);
  } catch (e) {
    console.error('sendSignal failed', e);
  }
}

// для получения входящих сообщений из auth.js (presence listener) 
export function handleIncomingMessage(fromUserKey, payload) {
  if (!payload || payload.type !== 'chat_message') return;
  const text = String(payload.text || '');
  const from = String(fromUserKey || '').toLowerCase();

  // если открыт чат с этим пользователем — добавим сообщение
  if (currentChat && currentChat.userKey === from) {
    currentChat.messages.push({ outgoing: false, text, ts: payload.ts || Date.now() });
    renderMessages();
    return;
  }

  // иначе — можно запомнить краткую историю и/или показать бейдж
  // здесь просто создаём небольшую визуальную подсказку в списке пользователей
  const row = document.querySelector(`.user-row[data-userkey="${from}"]`);
  if (row) {
    row.style.borderLeft = '4px solid #0b93f6';
    setTimeout(() => { row.style.borderLeft = ''; }, 5000);
  }

  // и сохраняем краткую непрочитанную запись
  try {
    const key = 'unread_' + from;
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    prev.push({ text: text.slice(0, 200), ts: Date.now() });
    localStorage.setItem(key, JSON.stringify(prev));
  } catch (e) {}
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
    setTimeout(() => { try { resultBlock.style.display = 'none'; } catch(e) {} }, hideAfterMs);
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
