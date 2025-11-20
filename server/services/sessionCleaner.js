// --- уборщик просроченных сессий

const state = require('../config/state');
const { persistSessions } = require('./dataStore');

function startSessionCleaner() {
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    Object.keys(state.sessions).forEach(k => {
      if (state.sessions[k].expiresAt < now) {
        delete state.sessions[k];
        changed = true;
      }
    });
    if (changed) persistSessions().catch(() => { });
  }, 1000 * 60 * 10); // каждые 10 минут
}

module.exports = { startSessionCleaner };
