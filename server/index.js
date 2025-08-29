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
  const sub = req.body;
  subscriptions.push(sub);
  console.log('Subscription saved');
  res.sendStatus(201);
});

// Триггер отправки пуша фиксированного шаблона. Вызывать curl'ом.
app.post('/send', async (req, res) => {
  const payload = JSON.stringify({
    title: 'Событие на сервере',
    body: `Шаблон: ${new Date().toLocaleTimeString()}`
  });

  const results = await Promise.all(subscriptions.map(sub => 
    webpush.sendNotification(sub, payload).catch(err => console.error(err))
  ));

  res.send('Push отправлен всем пользователям');
});

app.listen(3000, () => console.log('Server started!'));
