import { loadAndRenderUsers, ensureTopBar, initSWMessageHandler, initUnreadFromIDB } from "./userList.js";
import { ensurePresenceClient } from './auth.js';
import "../style.css";
import "./auth.js";
import "./presence.js";

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
    .then(reg => {
      console.log('SW зарегистрирован', reg);
      try {
        initSWMessageHandler();
      } catch (e) {
        console.warn('initSWMessageHandler failed', e);
      }
    })
    .catch(err => console.error('Ошибка регистрации SW:', err));
}

// Проверка режима установки и сетевого статуса
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

function isOnline() {
  return navigator.onLine;
}

// Обновление UI при загрузке
addEventListener('DOMContentLoaded', () => {
  document.getElementById('mode').textContent = isStandalone() ? 'PWA режим' : 'Браузер';
  document.getElementById('network').textContent = isOnline() ? 'Онлайн' : 'Офлайн';

  // TODO: прелоадер добавить
  const savedName = localStorage.getItem('pwaUserName');
  if (savedName) {
    const input = document.getElementById('userName');
    if (input) input.value = savedName;
    document.getElementById('register').style.display = 'none';
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function subscribeToPush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    alert('Недостаточно прав')
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const vapidResp = await fetch('/vapidPublicKey', { credentials: 'include' });
  const { publicKey } = await vapidResp.json();

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });

  const userKey = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();

  if (sub && userKey) {
    const res = await fetch('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ subscription: sub, userKey })
    });

    if (res.ok && res.status === 201) {
      alert('Подписка выполнена успешно');
      document.getElementById('pushBtnServ').style.display = 'none';
    } else {
      alert('Произошла ошибка при создании подписки');
    }
  } else {
    alert('Произошла ошибка при создании подписки');
  }
}

const pushBtn = document.getElementById('pushBtnServ');
if (pushBtn) {
  pushBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    const input = document.getElementById("userName");
    const raw = input ? input.value : '';
    const displayName = raw.trim();

    if (displayName) {
      localStorage.setItem('pwaUserName', displayName);
      await subscribeToPush();
      document.getElementById("login").disabled = false;
    } else {
      alert('Необходимо ввести имя пользователя')
      return;
    }
  });
}

// блокируем двойной тап
let lastTouchEnd = 0;
document.addEventListener("touchend", function (event) {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) {
    event.preventDefault();
  }
  lastTouchEnd = now;
}, false);

async function checkSession() {
  try {
    const resp = await fetch('/session', { credentials: 'include' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.authenticated) {
        console.log('checkSession done');

        const displayName = data.userName;
        // повторяем логику как после успешного login:
        localStorage.setItem('pwaUserName', displayName);

        // скрываем форму
        const btnLogin = document.getElementById("login");
        const btnRegister = document.getElementById("register");
        const headerAuth = document.getElementById("headerAuth");
        const userInput = document.getElementById("userName");
        const label = document.getElementById("userNameLabel");
        if (btnLogin) btnLogin.style.display = 'none';
        if (btnRegister) btnRegister.style.display = 'none';
        if (headerAuth) headerAuth.style.display = 'none';
        if (userInput) userInput.style.display = 'none';
        if (label) label.style.display = 'none';

        // проверка подписки
        try {
          const r = await fetch('/has-subscription', { credentials: 'include' });
          if (r.ok) {
            const j = await r.json();
            const el = document.getElementById('pushBtnServ');
            if (el) el.style.display = j.hasSubscription ? 'none' : 'block';
          }
        } catch (e) {
          const el = document.getElementById('pushBtnServ');
          if (el) el.style.display = 'block';
        }

        // top bar + presence
        ensureTopBar(displayName);
        await ensurePresenceClient();
        await loadAndRenderUsers();
        // инициализируем бейджи из IDB
        try { await initUnreadFromIDB(); } catch (e) { /* ignore */ }
      }
    }
  } catch (err) {
    console.error("Ошибка проверки сессии:", err);
  }
}

document.addEventListener('DOMContentLoaded', checkSession);
