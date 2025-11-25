import "../style.css";
import { initSWMessageHandler } from "./userList.js";
import { initPushButtonHandler } from "./push-notifications.js";
import { updateUIOnLoad } from "./ui.js";
import { checkSession } from "./api.js";
import { initPreventDoubleTap } from "./utils.js";

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
});
