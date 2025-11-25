// --- функции для регистрации и авторизации WebAuthn/Passkeys 


import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { loadAndRenderUsers, ensureTopBar } from "./userList.js";
import { ensurePresenceClient } from "./presence.js";
import { ensureKeypair } from "./cryptoSodium.js";
import { getInputValues, checkInstallMarker } from "./utils.js";
import { ensureServerHasCurrentSubscription } from "./push-notifications.js";

// регистрация нового пользователя
export async function handleRegister(resultBlock, btnRegister) {
  const { displayName, userKey } = getInputValues();
  if (!displayName) {
    alert("Введите имя пользователя");
    return;
  }

  try {
    // регистрация
    const regCheck = await fetch(`/is-registered?userName=${encodeURIComponent(userKey)}`).then(r => r.json());
    if (regCheck.registered) {
      alert("Пользователь с таким именем уже зарегистрирован!");
      return;
    }

    // отправляем displayName и userKey (userName)
    const regOptions = await fetch(`/register-challenge?userName=${encodeURIComponent(userKey)}`).then(r => r.json());
    const attResp = await startRegistration(regOptions);

    const regPayload = { ...attResp, userName: userKey, displayName };
    const regRes = await fetch(`/register-response?userName=${encodeURIComponent(userKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(regPayload)
    }).then(r => r.json());

    if (regRes?.success) {
      if (resultBlock) {
        resultBlock.textContent = "✅ Регистрация успешна!";
        setTimeout(() => resultBlock.textContent = "", 2000);
      }
      localStorage.setItem('pwaUserName', displayName);
      if (btnRegister) btnRegister.style.display = 'none';
    } else {
      if (resultBlock) {
        resultBlock.textContent = "❌ Ошибка регистрации";
        setTimeout(() => resultBlock.textContent = "", 2000);
      }
    }
  } catch (err) {
    console.error("Ошибка при проверке/регистрации:", err);
    alert("Ошибка при проверке/регистрации");
  }
}

// логин пользователя
export async function handleLogin(resultBlock, btnLogin, btnRegister) {
  const { displayName, userKey } = getInputValues();
  if (!displayName) {
    alert("Введите имя пользователя");
    return;
  }

  // dev‑сценарий: упрощённая авторизация для тестового пользователя "zxc"
  if (userKey === 'zxc') {
    try {
      // имитация регистрации
      const regPayloadPC = { displayName: userKey };
      await fetch(`/register-response?userName=${encodeURIComponent(userKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regPayloadPC)
      }).then(r => r.json());

      // имитация авторизации
      const authPayload = { userName: userKey, displayName };
      const res = await fetch(`/auth-response?userName=${encodeURIComponent(userKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: 'include',
        body: JSON.stringify(authPayload),
      }).then(r => r.json());

      if (res.success) {
        // скрываем форму
        [btnLogin, btnRegister, document.getElementById("headerAuth"),
         document.getElementById("userName"), document.getElementById("userNameLabel")]
          .forEach(el => { if (el) el.style.display = 'none'; });

        localStorage.setItem('pwaUserName', displayName);

        // создаём пару ключей и отсылаем публичный ключ на сервер
        try { await ensureKeypair(userKey); } catch (e) { console.error('[auth] ensureKeypair failed', e); }

        // проверка push‑подписки
        try {
          const el = document.getElementById('pushBtnServ');
          const ok = await ensureServerHasCurrentSubscription();
          if (ok === true) {
            const isFreshInstall = checkInstallMarker();
            if (el) el.style.display = isFreshInstall ? 'block' : 'none';
          } else {
            if (el) el.style.display = 'block';
          }
        } catch (e) {
          console.warn('Subscription check failed', e);
          const el = document.getElementById('pushBtnServ');
          if (el) el.style.display = 'block';
        }

        // подготовим top bar и загрузим список пользователей
        ensureTopBar(displayName);
        await ensurePresenceClient();
        await loadAndRenderUsers();
      } else {
        if (resultBlock) resultBlock.textContent = "❌ Ошибка авторизации";
      }
    } catch (err) {
      console.error("❌ Ошибка при dev‑логине:", err);
    }
    return;
  }

  // обычный сценарий логина через WebAuthn
  try {
    const options = await fetch(`/auth-challenge?userName=${encodeURIComponent(userKey)}`).then(r => r.json());
    if (!options || options.error) {
      alert("Вы не зарегистрированы!");
      return;
    }

    const authResp = await startAuthentication(options);
    const authPayload = { ...authResp, userName: userKey, displayName };

    const res = await fetch(`/auth-response?userName=${encodeURIComponent(userKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: 'include',
      body: JSON.stringify(authPayload),
    }).then(r => r.json());

    if (res?.success) {
      // скрываем форму
      [btnLogin, btnRegister, document.getElementById("headerAuth"),
       document.getElementById("userName"), document.getElementById("userNameLabel")]
        .forEach(el => { if (el) el.style.display = 'none'; });

      localStorage.setItem('pwaUserName', displayName);

      // создаём пару ключей и отсылаем публичный ключ на сервер
      try { await ensureKeypair(userKey); } catch (e) { console.error('[auth] ensureKeypair failed', e); }

      // проверим наличие действующей подписки у текущего (аутентифицированного) пользователя
      try {
        const el = document.getElementById('pushBtnServ');
        const ok = await ensureServerHasCurrentSubscription();

        // если ensureServerHasCurrentSubscription() вернул true — локальная и серверная подписки совпадают
        if (ok === true) {
          const isFreshInstall = checkInstallMarker();

          // при первой установке данных в localstorage считаем что приложение переустанавливалось
          if (el) el.style.display = isFreshInstall ? 'block' : 'none';

          // если ok !== true → есть проблема, нужно показать кнопку
        } else {
          if (el) el.style.display = 'block';
        }
      } catch (e) {
        console.warn('Subscription check failed', e);
        const el = document.getElementById('pushBtnServ');
        if (el) el.style.display = 'block';
      }

      // подготовим top bar и загрузим список пользователей
      ensureTopBar(displayName);

      await ensurePresenceClient();
      await loadAndRenderUsers();
    } else {
      if (resultBlock) resultBlock.textContent = "❌ Ошибка авторизации";
    }
  } catch (err) {
    console.error("❌ Ошибка при авторизации:", err);
  }
}
