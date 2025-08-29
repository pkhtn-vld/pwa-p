if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js');
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
});

async function initNotifications() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    console.warn('Уведомления не разрешены');
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  startLocalPush(reg);
}

function startLocalPush(registration) {
  setTimeout(() => {
    registration.showNotification('Тестовое пуш-уведомление', {
      body: `Сработало в ${new Date().toLocaleTimeString()}`,
      tag: 'local-push',
      icon: 'assets/icon-phone-192.png'
    });
    console.log('Сообщение отправлено');

  }, 5000);
}

document.getElementById('pushBtn').addEventListener('click', initNotifications);


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
  if (perm !== 'granted') { console.warn('Уведомления не разрешены'); return; }

  const reg = await navigator.serviceWorker.ready;
  const VAPID_PUBLIC = 'BB0xoYpI1ixUTh2MUiw-OF701Bm3wl-mS8FZkKGyM0Et06dGD4mzcRkMfKy4oSfBSA_Vtv6U3chpIz6GXDzpNIs';

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
  });

  // Отправляем subscription на сервер
  await fetch('http://localhost:3000/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });


  console.log('Subscribed and sent to server');
}

// подключаем к кнопке (или запускаем автоматически)
document.getElementById('pushBtnServ').addEventListener('click', subscribeToPush);