import { loadAndRenderUsers, ensureTopBar } from "./userList.js";
import { ensurePresenceClient } from './auth.js';
import "../style.css";
import "./auth.js";
import "./presence.js";
import "./userList.js";

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
    .then(reg => console.log('SW зарегистрирован', reg))
    .catch(err => console.error('Ошибка регистрации SW:', err));


    navigator.serviceWorker.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'push') return;
    const payload = msg.data || {};
    // payload.data.from — от кого
    // payload.payload — содержимое chat_message (если вы отправляете так)
    // Логика: если сейчас открыт чат с payload.data.from -> добавить сообщение в UI
    // иначе показать in-app toast (не системную нотификацию)
    try {
      handleIncomingPushFromSW(payload);
    } catch (e) { console.warn('handleIncomingPushFromSW error', e && e.message); }
  });
}

// заглушка
function handleIncomingPushFromSW(payload) {
  const from = payload && payload.data && payload.data.from;
  if (!from) {
    // показать in-app toast с payload.body
    // showInAppToast(payload.title || 'Новое сообщение', payload.body || '');
    alert('Новое сообщение: ' + payload.body);
    return;
  }
  // если открыт чат с from — вставляем сообщение, иначе — показать in-app toast
  // if (isChatOpenWith(from)) {
    // insertMessageToChat(from, payload);
    alert('Новое сообщение от: ' + from + ': ' + payload.body);
  // } else {
    // showInAppToast(payload.title || 'Новое сообщение', payload.body || '');
    // alert('Новое сообщение: ' + payload.body);
  // }
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

document.getElementById('pushBtnServ').addEventListener('click', async (e) => {
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

// блокируем двойной тап
let lastTouchEnd = 0;
document.addEventListener("touchend", function (event) {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) {
    event.preventDefault(); 
  }
  lastTouchEnd = now;
}, false);

// navigator.serviceWorker.addEventListener('message', (ev) => {
//   const msg = ev.data;
//   if (msg && msg.type === 'open_chat' && msg.from) {
//     const from = msg.from;
//     document.dispatchEvent(new CustomEvent('open_chat', { detail: { from } }));
//   }
// });

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

        const resultBlock = document.getElementById("result");
        // if (resultBlock) {
        //   resultBlock.textContent = "✅ Авторизация по cookie!\nДобро пожаловать " + displayName;
        //   setTimeout(() => { resultBlock.style.display = 'none'; }, 1000);
        // }

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
      }
    }
  } catch (err) {
    console.error("Ошибка проверки сессии:", err);
  }
}

document.addEventListener('DOMContentLoaded', checkSession);
