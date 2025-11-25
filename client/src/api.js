// --- функции для запросов к серверу 

import { ensurePresenceClient } from './presence.js';
import { loadAndRenderUsers, ensureTopBar, initUnreadFromIDB } from "./userList.js";

// запрос на проверку авторизации
export async function checkSession() {
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
