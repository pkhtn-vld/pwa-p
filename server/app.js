// --- сборка express‑приложения

const express = require('express');
const path = require('path');

const { setupMiddleware } = require('./middleware/middleware');
const setupRoutes = require('./routes');

const app = express();

// подключаем middleware
setupMiddleware(app);

// подключаем роуты
setupRoutes(app);

// если путь не совпал ни с одним API, отдать index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

module.exports = app;
