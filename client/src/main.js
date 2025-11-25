import "../style.css";
import { initSWMessageHandler } from "./userList.js";
import { initPushButtonHandler } from "./push-notifications.js";
import { updateUIOnLoad } from "./ui.js";
import { checkSession } from "./api.js";
import { initPreventDoubleTap } from "./utils.js";
import { handleRegister, handleLogin } from "./authPasskey.js";

// регистрируем sw
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

document.addEventListener('DOMContentLoaded', async () => {
  initPreventDoubleTap();
  updateUIOnLoad();
  initPushButtonHandler();
  await checkSession();

  // авторизация

  const btnRegister = document.getElementById("register");
  const btnLogin = document.getElementById("login");
  const resultBlock = document.getElementById("result");


  if (btnRegister) {
    btnRegister.addEventListener('click', () => handleRegister(resultBlock, btnRegister));
  }

  if (btnLogin) {
    btnLogin.addEventListener('click', () => handleLogin(resultBlock, btnLogin, btnRegister));
  }
});
