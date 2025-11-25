// --- работа с DOM

import { isStandalone, isOnline } from "./utils.js";

// обновление интерфейса при загрузке страницы
export function updateUIOnLoad() {
  const mode = document.getElementById('mode');
  const network = document.getElementById('network');

  if (mode) {
    mode.textContent = isStandalone() ? 'PWA режим' : 'Браузер';
  }

  if (network) {
    network.textContent = isOnline() ? 'Онлайн' : 'Офлайн';
  }

  // TODO: прелоадер добавить
  const savedName = localStorage.getItem('pwaUserName');
  if (savedName) {
    const input = document.getElementById('userName');
    if (input) input.value = savedName;
    document.getElementById('register').style.display = 'none';
  }
}

// создаёт top bar в DOM, если его нет
export function createTopBarIfMissing() {
  let top = document.getElementById('topBar');
  if (top) return top;

  top = document.createElement('div');
  top.id = 'topBar';

  // left: current user info
  const left = document.createElement('div');
  left.id = 'topBarLeft';

  const avatar = document.createElement('div');
  avatar.id = 'topBarAvatar';

  const nameEl = document.createElement('div');
  nameEl.id = 'topBarName';

  const statusEl = document.createElement('div');
  statusEl.id = 'topBarStatus';

  const leftWrap = document.createElement('div');
  leftWrap.style.display = 'flex';
  leftWrap.style.flexDirection = 'column';
  leftWrap.appendChild(nameEl);
  leftWrap.appendChild(statusEl);

  left.appendChild(avatar);
  left.appendChild(leftWrap);

  // right: profile/settings icon
  const right = document.createElement('div');
  right.id = 'topBarRight';

  const settingsBtn = document.createElement('button');
  settingsBtn.title = 'Настройки профиля';
  settingsBtn.id = 'settings-btn';
  settingsBtn.textContent = '⚙️';
  settingsBtn.addEventListener('click', () => { alert('Настройки профиля.'); });

  right.appendChild(settingsBtn);

  top.appendChild(left);
  top.appendChild(right);

  // вставляем в body в начало
  document.body.insertBefore(top, document.body.firstChild);
  return top;
}
