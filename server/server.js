require('dotenv').config();

const http = require('http');
const app = require('./app');

const { port, EXPECTED_ORIGIN } = require('./config/config');
const state = require('./config/state');
const { attachPresence } = require('./services/presenceService');
const { startSessionCleaner } = require('./services/sessionCleaner');
const { startup } = require('./startup');
const { handleSignal } = require('./services/signalHandler');
const { sessionModule } = require('./routes/session');

// инициализация сервера и восстановление состояния при старте
(async () => {
  try {
    // сначала инициализация состояния
    await startup();

    // создаём HTTP‑сервер
    const server = http.createServer(app);

    // запускает и хранит живой WebSocket‑сервис
    // используется для определения онлайн пользователей, пересылки сообщений
    state.presenceObj = attachPresence(server, {
      getSessionById: (sessionId) => sessionModule.getSession(sessionId) || null,
      // getSessionById: (sessionId) => state.sessions[sessionId] || null,
      onSignal: handleSignal,
      expectedOrigin: EXPECTED_ORIGIN,
      allowSessionQuery: false,
    });

    // слушаем порт
    server.listen(port, () => console.log(`Server started on ${port}!`));

    // запуск уборщика просроченных сессий
    startSessionCleaner();
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
})();
