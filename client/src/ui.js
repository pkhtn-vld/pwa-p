// --- работа с DOM

import { isStandalone, isOnline } from "./utils.js";

// обновление интерфейса при загрузке страницы
export function updateUIOnLoad() {
  const mode = document.getElementById('mode');
  const network = document.getElementById('network');

  mode?.textContent = isStandalone() ? 'PWA режим' : 'Браузер';
  network?.textContent = isOnline() ? 'Онлайн' : 'Офлайн';

  // TODO: прелоадер добавить
  const savedName = localStorage.getItem('pwaUserName');
  if (savedName) {
    const input = document.getElementById('userName');
    if (input) input.value = savedName;
    document.getElementById('register').style.display = 'none';
  }
}
