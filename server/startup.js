// --- процедура запуска и восстановления состояния

const { CRED_FILE, SESS_FILE, SUBS_FILE, subscriptionsByUser } = require('./config/config');
const state = require('./config/state');
const { ensureDataFiles, loadJSON, downloadFromWebdavIfMissing } = require('./services/dataStore');

/**
 * Выполняет инициализацию состояния приложения:
 * - проверяет наличие файлов
 * - загружает данные из JSON
 * - подтягивает из WebDAV при необходимости
 */
async function startup() {
  try {
    // убедимся, что файлы существуют
    await ensureDataFiles();

    // если есть webdavClient — попробуем восстановить недостающие файлы
    if (state.webdavClient) {
      await downloadFromWebdavIfMissing(CRED_FILE, '/pwa/credentials.json').catch(() => { });
      await downloadFromWebdavIfMissing(SESS_FILE, '/pwa/sessions.json').catch(() => { });
      await downloadFromWebdavIfMissing(SUBS_FILE, '/pwa/subscriptions.json').catch(() => { });
    }

    // загрузим сохранённые креды и сессии
    state.savedCredentials = await loadJSON(CRED_FILE);
    state.sessions = await loadJSON(SESS_FILE);

    // загрузим подписки
    const loadedSubs = await loadJSON(SUBS_FILE);
    if (loadedSubs && typeof loadedSubs === 'object') {
      Object.keys(loadedSubs).forEach(k => {
        const lk = String(k).toLowerCase();
        subscriptionsByUser[lk] = Array.isArray(loadedSubs[k]) ? loadedSubs[k] : [];
      });
    }

    console.log('[startup] state initialized');
  } catch (err) {
    console.error('[startup] fatal error:', err);
    throw err;
  }
}

module.exports = { startup };
