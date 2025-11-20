// --- сервис‑модуль, обрабатывающий события onSignal

const { webpush, subscriptionsByUser } = require('../config/config');
const { persistSubscriptions } = require('./dataStore');

/**
 * Обработчик сигналов от WebSocket presence‑сервиса.
 * Вызывается при каждом входящем signal‑сообщении.
 */
async function handleSignal(from, to, payload, delivered) {
  console.log('signal', from, '->', to, 'delivered=', delivered);
  console.log('payload: ', payload);
  console.log('onSignal:', {
    from,
    to,
    delivered,
    text: (payload && payload.text) ? String(payload.text).slice(0, 50) : ''
  });

  // если сообщение не было доставлено через WS — отправим web‑push подписчикам получателя
  if (!delivered) {
    try {
      const toKey = (to || '').toString().toLowerCase();
      const subs = subscriptionsByUser[toKey] || [];

      // Дедупликация подписок по endpoint
      const uniq = [];
      const seen = new Set();
      for (const s of subs) {
        const ep = s && s.endpoint ? s.endpoint : '';
        if (ep && !seen.has(ep)) {
          seen.add(ep);
          uniq.push(s);
        }
      }

      console.log('-> will send webpush, subsCount=', uniq.length,
        'toKey=', toKey,
        'endpoints=', uniq.map(s => (s.endpoint || '').slice(0, 80)));

      if (uniq.length > 0) {
        const pushPayload = JSON.stringify({
          title: `Новое сообщение от ${from.charAt(0).toUpperCase() + from.slice(1)}`,
          body: String((payload && payload.text) || '').slice(0, 200),
          data: { from, payload }
        });

        await Promise.all(uniq.map(async (s) => {
          try {
            await webpush.sendNotification(s, pushPayload);
            console.log('webpush sent to', (s.endpoint || '').slice(0, 80));
          } catch (err) {
            console.error('webpush send error', err && err.statusCode);
            // удалить подписку при 410 Gone
            if (err && err.statusCode === 410) {
              subscriptionsByUser[toKey] =
                (subscriptionsByUser[toKey] || []).filter(x => x.endpoint !== s.endpoint);

              // сразу сохранить изменения
              persistSubscriptions().catch(e => console.error('persistSubscriptions err', e));
            }
          }
        }));
      } else {
        console.log('-> no subscriptions for', toKey);
      }
    } catch (e) {
      console.error('onSignal->webpush error', e && e.stack || e);
    }
  } else {
    console.log('-> skip webpush because delivered=true');
  }
}

module.exports = { handleSignal };
