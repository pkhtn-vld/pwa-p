// --- push notifications(сервер->браузер)


// преобразует строку в формате Base64URL в массив байтов Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// подписка браузера на push
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

// обработчик кнопки подписки на push-уведомления
export function initPushButtonHandler() {
  const pushBtn = document.getElementById('pushBtnServ');
  if (!pushBtn) return;

  pushBtn.addEventListener('click', async (event) => {
    event.preventDefault();

    const input = document.getElementById("userName");
    const raw = input ? input.value : '';
    const displayName = raw.trim();

    if (displayName) {
      localStorage.setItem('pwaUserName', displayName);
      await subscribeToPush();
      const loginBtn = document.getElementById("login");
      if (loginBtn) loginBtn.disabled = false;
    } else {
      alert('Необходимо ввести имя пользователя');
    }
  });
}

// проверяет, совпадает ли локальная push‑подписка с серверной
export async function ensureServerHasCurrentSubscription() {
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
        body: JSON.stringify({ subscription: localSub, userKey: (localStorage.getItem('pwaUserName') || '').trim().toLowerCase() })
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