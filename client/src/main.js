import "../style.css";
import "./auth.js";
import "./presence.js";
import "./userList.js";

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
    .then(reg => console.log('SW зарегистрирован', reg))
    .catch(err => console.error('Ошибка регистрации SW:', err));
}

/////////////////////////////////////
// Отладка
(function installGlobalClientLogger(){
  function sendDebug(payload) {
    try {
      // Пытаемся отправить быстро: keepalive и короткий таймаут.
      fetch('/debug-log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('error', function(ev) {
    try {
      const payload = {
        level: 'error',
        message: String(ev.message || ''),
        filename: ev.filename || '',
        lineno: ev.lineno || 0,
        colno: ev.colno || 0,
        stack: (ev.error && ev.error.stack) ? String(ev.error.stack) : null,
        ts: Date.now()
      };
      sendDebug(payload);
    } catch (e) {}
  });

  window.addEventListener('unhandledrejection', function(ev) {
    try {
      const reason = ev.reason || {};
      const payload = {
        level: 'unhandledrejection',
        reason: typeof reason === 'string' ? reason : (reason && reason.message) || JSON.stringify(reason) || String(reason),
        stack: reason && reason.stack ? reason.stack : null,
        ts: Date.now()
      };
      sendDebug(payload);
    } catch (e) {}
  });

  // перехват fetch ошибок (короткий instrument)
  const _origFetch = window.fetch;
  window.fetch = function() {
    return _origFetch.apply(this, arguments).catch(err => {
      try {
        sendDebug({ level: 'fetch-error', message: String(err && err.message), ts: Date.now() });
      } catch (e) {}
      throw err;
    });
  };
})();
/////////////////////////////////////

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

  // to dev
  fetch('/debug-log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'subscribeToPush',
          sub: sub,
          userKey: userKey
        }),
        keepalive: true
      }).catch(() => { });

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

navigator.serviceWorker.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg && msg.type === 'open_chat' && msg.from) {
    const from = msg.from;
    document.dispatchEvent(new CustomEvent('open_chat', { detail: { from } }));
  }
});
