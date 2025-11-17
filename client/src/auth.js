import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { loadAndRenderUsers, ensureTopBar, updateOnlineList, setPresenceClient, handleIncomingMessage, showInAppToast } from "./userList.js";
import { createPresenceClient } from "./presence.js";

let pc = null;

export async function ensurePresenceClient() {
  if (pc) return pc;
  pc = createPresenceClient();
  // Попытка подключиться немедленно, если уже есть сессия
  await pc.connectWhenAuth();

  try {
    // отправим текущее состояние (будет буферизовано, если ws ещё не открыт)
    sendVisibilityState(pc, document.visibilityState === 'visible');

    // слушаем изменения видимости
    document.addEventListener('visibilitychange', () => {
      const isVisible = document.visibilityState === 'visible';
      sendVisibilityState(pc, isVisible);
    }, { passive: true });

    // pagehide — попытка отправить перед закрытием/сворачиванием
    window.addEventListener('pagehide', () => {
      try { sendVisibilityState(pc, false); } catch (e) { }
    });

    // опционально: beforeunload (меньше шансов успеха, но лучше попытаться)
    window.addEventListener('beforeunload', () => {
      try { sendVisibilityState(pc, false); } catch (e) { }
    });
  } catch (e) { console.warn('visibility hook failed', e); }

  setPresenceClient(pc);
  attachPresenceListeners(pc);
  return pc;
}

// функция отправки видимости
function sendVisibilityState(pc, visible) {
  try {
    if (!pc) return;
    if (typeof pc.sendVisibility === 'function') {
      pc.sendVisibility(visible);
      return;
    }
    // fallback: если нет sendVisibility — попробуем sendRaw or raw()
    if (typeof pc.sendRaw === 'function') {
      pc.sendRaw({ type: 'visibility', visible: !!visible });
      return;
    }
    const ws = (pc.raw && pc.raw()) || null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'visibility', visible: !!visible }));
    }
  } catch (e) { console.warn('sendVisibilityState failed', e); }
}

function attachPresenceListeners(p) {
  if (!p) return;
  p.on('presence', (online) => {
    console.log('online list', online);
    updateOnlineList(online);
  });
  p.on('signal', (from, payload) => {
    ///////
    try {
      if (payload && payload.type === 'chat_message') {
        try {
          const handled = handleIncomingMessage(from, payload);
          // если сообщение НЕ добавлено прямо в открытый чат — покажем in-app toast (не системную нотификацию)
          if (!handled) {
            showInAppToast(`Новое сообщение от ${from}`, String(payload.text || '').slice(0, 200), { from });
          }
        } catch (e) {
          console.error('signal handler error', e);
        }
        return;
      }
    } catch (e) {
      console.error('signal handler error', e);
    }
    console.log('signal from', from, payload);
  });
  // p.on('open'...)
}

function getInputValues() {
  const input = document.getElementById("userName");
  const raw = input ? input.value : '';
  const displayName = raw.trim();
  const userKey = displayName.toLowerCase();
  return { displayName, userKey };
}

// safe DOM getters
const btnRegister = document.getElementById("register");
const btnLogin = document.getElementById("login");
const resultBlock = document.getElementById("result");

if (btnRegister) {
  btnRegister.addEventListener('click', async () => {
    const { displayName, userKey } = getInputValues();
    if (!displayName) {
      alert("Введите имя пользователя");
      return;
    }

    try {
      // проверка через сервер
      const regCheck = await fetch(`/is-registered?userName=${encodeURIComponent(userKey)}`).then(r => r.json());
      if (regCheck.registered) {
        alert("Пользователь с таким именем уже зарегистрирован!");
        return;
      }

      // регистрация
      const regOptions = await fetch(`/register-challenge?userName=${encodeURIComponent(userKey)}`).then(r => r.json());
      const attResp = await startRegistration(regOptions);

      // отправляем displayName и userKey (userName) — важно для сервера
      const regPayload = Object.assign({}, attResp, { userName: userKey, displayName });

      const regRes = await fetch(`/register-response?userName=${encodeURIComponent(userKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regPayload)
      }).then(r => r.json());

      if (regRes && regRes.success) {
        if (resultBlock) resultBlock.textContent = "✅ Регистрация успешна!";
        localStorage.setItem('pwaUserName', displayName);
        btnRegister.style.display = 'none';
      } else {
        if (resultBlock) resultBlock.textContent = "❌ Ошибка регистрации";
      }
    } catch (err) {
      console.error("Ошибка при проверке/регистрации:", err);
      alert("Ошибка при проверке/регистрации");
    }
  });
}

if (btnLogin) {
  btnLogin.addEventListener('click', async () => {
    const { displayName, userKey } = getInputValues();
    if (!displayName) {
      alert("Введите имя пользователя");
      return;
    }



    // to dev
    if (userKey === 'zxc') {

      const regPayloadPC = {};
      regPayloadPC.displayName = userKey;
      await fetch(`/register-response?userName=${encodeURIComponent(userKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regPayloadPC)
      }).then(r => r.json());

      const authPayload = Object.assign({}, 'authResp', { userName: userKey, displayName });
      const res = await fetch(`/auth-response?userName=${encodeURIComponent(userKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: 'include',
        body: JSON.stringify(authPayload),
      }).then(r => r.json());
      if (res.success) {
        // скрываем форму
        if (btnLogin) btnLogin.style.display = 'none';
        if (btnRegister) btnRegister.style.display = 'none';
        const headerAuth = document.getElementById("headerAuth");
        if (headerAuth) headerAuth.style.display = 'none';

        const userInput = document.getElementById("userName");
        if (userInput) userInput.style.display = 'none';
        const label = document.getElementById("userNameLabel");
        if (label) label.style.display = 'none';

        // Показать успешный текст + приветствие (используем displayName)
        if (resultBlock) {
          localStorage.setItem('pwaUserName', displayName);

          // проверим наличие подписки у текущего (аутентифицированного) пользователя
          try {
            // запрос сделаем с credentials: 'include' чтобы cookie-сессия использовалась
            const r = await fetch('/has-subscription', { credentials: 'include' });
            if (r.ok) {
              const j = await r.json();
              if (j && j.hasSubscription) {
                // подписка уже есть — прячем кнопку
                const el = document.getElementById('pushBtnServ');
                if (el) el.style.display = 'none';
              } else {
                // нет подписки — показываем кнопку
                const el = document.getElementById('pushBtnServ');
                if (el) el.style.display = 'block';
              }
            } else {
              // если запрос вернул 401 — не авторизован, показываем кнопку как fallback
              const el = document.getElementById('pushBtnServ');
              if (el) el.style.display = 'block';
              alert('Ошибка при выполнении запроса на подписку')
            }
          } catch (e) {
            alert('has-subscription check failed \n' + e);
            // в случае ошибки по сети — отображаем кнопку (пользователь может захотеть подписаться)
            const el = document.getElementById('pushBtnServ');
            if (el) el.style.display = 'block';
          }

          // скрываем результат и показываем/скроем кнопку спустя небольшой таймаут UX (как у тебя было)
          try {
            if (resultBlock) {
              setTimeout(() => { resultBlock.style.display = 'none'; }, 1000);
            }
          } catch (e) { }
        }

        // подготовим top bar и загрузим список пользователей
        ensureTopBar(displayName);

        await ensurePresenceClient();
        try {
          await loadAndRenderUsers();
        } catch (err) {
          console.error('Не удалось загрузить пользователей после логина:', err);
        }
      } else {
        if (resultBlock) resultBlock.textContent = "❌ Ошибка авторизации";
      }
      
      return;
    }



    try {
      const options = await fetch(`/auth-challenge?userName=${encodeURIComponent(userKey)}`).then(r => r.json());
      if (!options || Object.keys(options).length === 0) {
        return;
      }
      if (options.error) {
        alert("Вы не зарегистрированы!");
        return;
      }

      const authResp = await startAuthentication(options);

      // отправляем вместе с userKey/displayName; credentials: include для cookie
      const authPayload = Object.assign({}, authResp, { userName: userKey, displayName });
      const res = await fetch(`/auth-response?userName=${encodeURIComponent(userKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: 'include',
        body: JSON.stringify(authPayload),
      }).then(r => r.json());

      if (!res || Object.keys(res).length === 0) {
        return;
      }

      if (res.success) {
        // скрываем форму
        if (btnLogin) btnLogin.style.display = 'none';
        if (btnRegister) btnRegister.style.display = 'none';
        const headerAuth = document.getElementById("headerAuth");
        if (headerAuth) headerAuth.style.display = 'none';

        const userInput = document.getElementById("userName");
        if (userInput) userInput.style.display = 'none';
        const label = document.getElementById("userNameLabel");
        if (label) label.style.display = 'none';

        // Показать успешный текст + приветствие (используем displayName)
        if (resultBlock) {
          localStorage.setItem('pwaUserName', displayName);

          // проверим наличие действующей подписки у текущего (аутентифицированного) пользователя
          try {
            const ok = await ensureServerHasCurrentSubscription();

            // если ensureServerHasCurrentSubscription() вернул true — локальная и серверная подписки совпадают
            if (ok === true) {
              const el = document.getElementById('pushBtnServ');
              if (el) el.style.display = 'none';
              console.log('Push subscription OK — hiding push button');
            }
            // если ok !== true → есть проблема, нужно показать кнопку
            else {
              const el = document.getElementById('pushBtnServ');
              if (el) el.style.display = 'block';
              console.log('Push subscription mismatch or missing — showing push button');
            }
          } catch (e) {
            console.warn('Subscription check failed', e);
            const el = document.getElementById('pushBtnServ');
            if (el) el.style.display = 'block';
          }

          // скрываем результат и показываем/скроем кнопку спустя небольшой таймаут UX (как у тебя было)
          try {
            if (resultBlock) {
              setTimeout(() => { resultBlock.style.display = 'none'; }, 1000);
            }
          } catch (e) { }
        }

        // подготовим top bar и загрузим список пользователей
        ensureTopBar(displayName);

        await ensurePresenceClient();
        try {
          await loadAndRenderUsers();
        } catch (err) {
          console.error('Не удалось загрузить пользователей после логина:', err);
        }
      } else {
        if (resultBlock) resultBlock.textContent = "❌ Ошибка авторизации";
      }
    } catch (err) {
      console.error("❌ Ошибка при авторизации:", err);
    }
  });
}

async function ensureServerHasCurrentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const localSub = await reg.pushManager.getSubscription(); // может быть null
    // получим сохранённые endpoint'ы с сервера
    const r = await fetch('/has-subscription', { credentials: 'include' });
    if (!r.ok) return;
    const j = await r.json();
    const serverEndpoints = Array.isArray(j.endpoints) ? j.endpoints : [];

    const localEndpoint = localSub && localSub.endpoint ? String(localSub.endpoint) : null;

    // если у клиента есть подписка но её endpoint нет на сервере — отправим на /subscribe (обновим)
    if (localEndpoint && serverEndpoints.indexOf(localEndpoint) === -1) {
      console.log('Local subscription endpoint not found on server — sending to /subscribe');
      await fetch('/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ subscription: localSub, userKey: (localStorage.getItem('pwaUserName')||'').trim().toLowerCase() })
      });
      return;
    }

    // если у клиента нет подписки, но сервер думает что подписка есть — вероятно клиент удалил подписку (переустановил PWA)
    if (!localEndpoint && serverEndpoints.length > 0) {
      console.log('Server has endpoints, but client has no subscription. Prompt user to re-subscribe or try to subscribe automatically.');
      return;
    }

    // совпадает — всё ок
    return true;
  } catch (e) {
    console.warn('ensureServerHasCurrentSubscription failed', e);
  }
}
