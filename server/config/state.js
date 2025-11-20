// --- централизованное хранилище состояния приложения

// { userName: [ { id, publicKeyBase64, counter, transports, createdAt } ] }
let savedCredentials = {};

// { sessionId: { userName, createdAt, expiresAt } }
let sessions = {};

// объект клиента WebDAV
let webdavClient = null;

// Белый список пользователей
let allowUserList = [];

// объект управления присутствием пользователей
let presenceObj = null;


module.exports = {
  savedCredentials,
  webdavClient,
  sessions,
  allowUserList,
  presenceObj,
};
