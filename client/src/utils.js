// --- вспомогательные функции


// запущено ли приложение как PWA
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

// есть ли у браузера доступ к сети
export function isOnline() {
  return navigator.onLine;
}

// отключаем двойной тап на мобильных
export function initPreventDoubleTap() {
  let lastTouchEnd = 0;

  document.addEventListener("touchend", (event) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      event.preventDefault();
    }
    lastTouchEnd = now;
  }, false);
}

// безопасное извлечение и нормализация userName из input#userName
export function getInputValues() {
  var input = document.getElementById("userName");
  if (!input || typeof input.value !== "string") {
    return { displayName: "", userKey: "" };
  }

  // базовая очистка
  var raw = input.value.trim();

  // удаляем HTML-теги
  raw = raw.replace(/<[^>]*>/g, "");

  // удаляем управляющие символы
  raw = raw.replace(/[\x00-\x1F\x7F]/g, "");

  // удаляем zero-width и bidi метки
  raw = raw.replace(/[\u200B-\u200F\u202A-\u202E]/g, "");

  // нормализация Unicode — к совместимому каноническому виду
  try { raw = raw.normalize("NFKC"); } catch (e) { /* старые браузеры: игнорируем */ }

  // убрать лишние пробелы внутри строки
  raw = raw.replace(/\s+/g, " ").trim();

  // отсекаем CR/LF
  raw = raw.replace(/[\r\n]+/g, " ");

  // проверяем длину и ограничиваем
  var MAX_LEN = 20;
  if (raw.length === 0) return { displayName: "", userKey: "" };
  if (raw.length > MAX_LEN) raw = raw.slice(0, MAX_LEN).trim();

  var displayName = raw;

  // создаём безопасный ключ (slug) для URL/ключей/идентификаторов
  //    - убираем диакритику (NFKD + удаление комбинирующих знаков)
  //    - оставляем буквы/цифры/пробел/_/-
  //    - пробелы => дефисы, убираем крайние дефисы
  var slug = displayName;
  try {
    // нормализуем Unicode
    slug = slug.normalize("NFKD");
    // убираем диакритические знаки (для латиницы)
    slug = slug.replace(/\p{M}/gu, "");
  } catch (e) { }

  slug = slug.toLowerCase()
    .replace(/[^a-zа-яё0-9 _\-]/g, "") // кириллица + латиница + цифры
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  // если slug пуст - используем детерминированный fallback-хеш
  var userKey = slug;
  if (!userKey) {
    userKey = hashSimple(displayName); // компактный детерминированный хеш (см. ниже)
  }

  return { displayName: displayName, userKey: userKey };
}

// детерминированный хеш (djb2 → безопасный fallback, синхронный)
function hashSimple(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i); // h * 33 + c
    h = h & 0xFFFFFFFF;
  }
  // возвращаем безопасную строку: префикс + допустимые символы
  return "h" + (h >>> 0).toString(36);
}

// Проверка маркера установки
export function checkInstallMarker() {
  const marker = localStorage.getItem('installTime');
  if (!marker) {
    // Новая установка или очистка данных
    const now = Date.now();
    localStorage.setItem('installTime', now);
    return true;
  } else {
    return false;
  }
}
