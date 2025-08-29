// index.js
require('dotenv').config();
const express = require('express');
const { json } = require('express');
const webpush = require('web-push');
const cors = require('cors');
const app = express();
const path = require('path');

app.use(cors());
app.use(json());
app.use(express.static(path.join(__dirname, '../client')));

const VAPID_PUBLIC = process.env.publicKey;
const VAPID_PRIVATE = process.env.privateKey;

webpush.setVapidDetails('mailto:ex@mail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Храним последнюю подписку в памяти (тест)
const subscriptions = [];

app.post('/subscribe', (req, res) => {
  savedSubscription = req.body;
  console.log('Subscription saved');
  res.sendStatus(201);
});

// Триггер отправки пуша фиксированного шаблона. Вызывать curl'ом.
app.post('/send', async (req, res) => {
  if (!savedSubscription) return res.status(400).send('No subscription saved');

  const payload = JSON.stringify({
    title: 'Тестовое пуш-уведомление (сервер)',
    body: `Шаблон: событие на сервере в ${new Date().toLocaleTimeString()}`,
    // url: '/' // можно передать URL для открытия при клике
  });

  try {
    await webpush.sendNotification(savedSubscription, payload);
    res.send('OK');
  } catch (err) {
    console.error('Push error', err);
    res.status(500).send(err.toString());
  }
});

app.listen(3000, () => console.log('Server started on http://localhost:3000'));
