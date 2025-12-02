// Минимальный сигналинг + WebRTC аудио-звонки через ваш presence WS.
// Экспортируем: initiateCallTo(userKey), handleCallSignal(from, payload), attachCallButtonHandler()

import { state } from './state.js';

// helper: получить ICE-серверы (TURN/STUN) с сервера; если не удалось — вернуть fallback STUN
// comment: запрашиваем защищённый маршрут /get-turn-credentials (требует авторизации)
async function getIceServers() {
  try {
    console.log('// call: запрашиваю ICE-серверы с /get-turn-credentials');
    const resp = await fetch('/get-turn-credentials', { credentials: 'include' });
    if (!resp.ok) {
      console.warn('// call: /get-turn-credentials вернул не OK, статус=', resp.status);
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    const json = await resp.json().catch(() => null);
    if (!json || !Array.isArray(json.iceServers) || json.iceServers.length === 0) {
      console.log('// call: пустой список iceServers от сервера — использую fallback STUN');
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    console.log('// call: получил iceServers, count=', json.iceServers.length);
    return json.iceServers;
  } catch (e) {
    console.warn('// call: ошибка при запросе iceServers, использую fallback STUN', e);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

// Небольшой локальный toast (чтобы не тянуть зависимости и не создавать циклических импортов)
function localToast(text) {
  try {
    let el = document.getElementById('call-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'call-toast';
      el.style.position = 'fixed';
      el.style.right = '12px';
      el.style.top = '12px';
      el.style.zIndex = 99999;
      el.style.padding = '8px 12px';
      el.style.background = 'rgba(0,0,0,0.8)';
      el.style.color = '#fff';
      el.style.borderRadius = '8px';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
    setTimeout(() => { try { el.style.display = 'none'; } catch (e) {} }, 3000);
  } catch (e) { console.log(text); }
}

const activeCalls = new Map(); // callId -> { pc, localStream, role, to/from, offerSdp, uiIds }

// утилита
function makeId() { return String(Math.random()).slice(2,10) + '-' + Date.now(); }

// UI: показать входящий попап
function showIncomingUI(from, callId) {
  const id = 'incoming-call-' + callId;
  if (document.getElementById(id)) return id;
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.style.position = 'fixed';
  wrap.style.left = '12px';
  wrap.style.bottom = '12px';
  wrap.style.zIndex = 99999;
  wrap.style.padding = '10px';
  wrap.style.background = '#fff';
  wrap.style.border = '1px solid #ccc';
  wrap.style.borderRadius = '8px';
  wrap.style.boxShadow = '0 6px 18px rgba(0,0,0,0.12)';
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '10px';
  wrap.textContent = `${String(from).charAt(0).toUpperCase() + String(from).slice(1)} звонит`;

  const accept = document.createElement('button');
  accept.textContent = 'Принять';
  accept.style.background = '#28a745';
  accept.style.color = '#fff';
  accept.style.border = 'none';
  accept.style.padding = '6px 10px';
  accept.style.borderRadius = '6px';

  const reject = document.createElement('button');
  reject.textContent = 'Отклонить';
  reject.style.background = '#dc3545';
  reject.style.color = '#fff';
  reject.style.border = 'none';
  reject.style.padding = '6px 10px';
  reject.style.borderRadius = '6px';

  wrap.appendChild(accept);
  wrap.appendChild(reject);
  document.body.appendChild(wrap);

  accept.addEventListener('click', async () => {
    try {
      await acceptCall(from, callId);
    } catch (e) { console.error('acceptCall', e); localToast('Ошибка принятия звонка'); }
  });
  reject.addEventListener('click', () => {
    // отправим call_end
    try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'rejected' }); } catch (e) {}
    cleanupCall(callId);
  });

  return id;
}

// UI: показать прелоадер для звонящего
function showOutgoingUI(callId, to) {
  const id = 'outgoing-call-' + callId;
  if (document.getElementById(id)) return id;
  const el = document.createElement('div');
  el.id = id;
  el.style.position = 'fixed';
  el.style.left = '12px';
  el.style.bottom = '12px';
  el.style.zIndex = 99999;
  el.style.padding = '10px';
  el.style.background = 'rgba(0,0,0,0.85)';
  el.style.color = '#fff';
  el.style.borderRadius = '8px';
  el.textContent = `Звонок ${to}… Ожидание ответа`;
  document.body.appendChild(el);
  return id;
}

function removeUI(id) { const el = document.getElementById(id); if (el) try { el.remove(); } catch (e) {} }

// cleanup
function cleanupCall(callId) {
  const info = activeCalls.get(callId);
  if (!info) return;
  try {
    // остановка/закрытие AudioContext и интервала анализа (если есть)
    try {
      if (info.levelIntervalId) {
        clearInterval(info.levelIntervalId);
        info.levelIntervalId = null;
      }
      if (info.localAudioContext) {
        try { info.localAudioContext.close(); } catch (e) { /* ignore */ }
        info.localAudioContext = null;
      }
      if (info.remoteAudioContext) {
        try { info.remoteAudioContext.close(); } catch (e) { /* ignore */ }
        info.remoteAudioContext = null;
      }
    } catch (e) { console.warn('[call][cleanup] audio analyser cleanup failed', e); }

    // удалить audio элемент (remote)
    try {
      const audioEl = document.getElementById('call-audio-' + callId);
      if (audioEl) {
        try { audioEl.srcObject = null; } catch (e) {}
        try { audioEl.remove(); } catch (e) {}
      }
    } catch (e) { /* ignore */ }

    // закрыть pc
    if (info.pc) {
      try { info.pc.close(); } catch (e) { /* ignore */ }
      info.pc = null;
    }

    // очистить таймаут, если установлен
    try {
      if (info.timeoutId) { clearTimeout(info.timeoutId); info.timeoutId = null; }
    } catch (e) { /* ignore */ }

    // остановить локальные треки
    if (info.localStream) {
      try { info.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {}
      info.localStream = null;
    }
    // удалить UI
    if (info.uiIds) {
      if (info.uiIds.incoming) removeUI(info.uiIds.incoming);
      if (info.uiIds.outgoing) removeUI(info.uiIds.outgoing);
    }
  } catch (e) {
    console.warn('[call][cleanup] cleanupCall threw', e);
  }
  activeCalls.delete(callId);
}

// get mic
async function acquireMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw e;
  }
}

// Инициатор звонка
export async function initiateCallTo(userKey) {
  console.log('// call: enter initiateCallTo userKey=', userKey);
  try {
    if (!state.presenceClient) { console.warn('// call: нет state.presenceClient'); localToast('Нет WS соединения'); return; }
    const me = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();
    if (!me) { console.warn('// call: неавторизован'); localToast('Неавторизован'); return; }
    const to = String(userKey).toLowerCase();
    const callId = makeId();
    const outgoingUI = showOutgoingUI(callId, to);

    // comment: получаем iceServers (TURN/STUN) с сервера; fallback на публичный STUN
    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });

    // Логи состояний для отладки
    pc.oniceconnectionstatechange = () => console.log('// call: oniceconnectionstatechange', callId, pc.iceConnectionState);
    pc.onconnectionstatechange = () => console.log('// call: onconnectionstatechange', callId, pc.connectionState);
    pc.onicegatheringstatechange = () => console.log('// call: onicegatheringstatechange', callId, pc.iceGatheringState);

    let localStream;
    try {
      localStream = await acquireMic();
      console.log('// call: acquired localStream, audio tracks:', localStream.getAudioTracks());
    } catch (e) {
      removeUI(outgoingUI);
      localToast('Доступ к микрофону отклонён');
      console.warn('// call: getUserMedia failed', e);
      return;
    }

    // добавляем локальные треки до создания offer
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    console.log('// call: added local tracks to pc; pc.getSenders():', pc.getSenders());

    // ontrack — воспроизводим удалённый поток и пытаемся play()
    pc.ontrack = (ev) => {
      try {
        let audio = document.getElementById('call-audio-' + callId);
        if (!audio) {
          audio = document.createElement('audio');
          audio.id = 'call-audio-' + callId;
          audio.autoplay = true;
          audio.playsInline = true;
          audio.style.display = 'none';
          document.body.appendChild(audio);
        }
        audio.muted = false;
        audio.volume = 1.0;
        const remoteStream = (ev.streams && ev.streams[0]) || ev.stream || null;
        audio.srcObject = remoteStream;
        console.log('// call: ontrack set srcObject', callId, remoteStream);
        audio.play().then(() => {
          console.log('// call: audio.play OK', callId);
        }).catch((err) => {
          console.warn('// call: audio.play failed', callId, err);
        });
      } catch (e) {
        console.error('// call: ontrack handler failed', callId, e);
      }
    };

    // ICE кандидаты — отправляем в JSON форме и логируем
    pc.onicecandidate = (ev) => {
      if (ev && ev.candidate) {
        try {
          const cand = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
          console.log('// call: sending candidate', callId, cand);
          state.presenceClient.sendSignal(to, { type: 'call_candidate', callId, candidate: cand });
        } catch (err) {
          console.warn('// call: send candidate failed', err);
        }
      }
    };

    // create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log('// call: created offer, local SDP length:', (pc.localDescription && pc.localDescription.sdp && pc.localDescription.sdp.length) || 0);

    // assemble info and save
    const info = { pc, localStream, role: 'caller', to, uiIds: { outgoing: outgoingUI } };
    activeCalls.set(callId, info);

    // send offer via presenceClient (sdp string)
    try {
      state.presenceClient.sendSignal(to, { type: 'call_offer', callId, sdp: offer.sdp });
      console.log('// call: sent call_offer', callId, 'to', to);
    } catch (e) {
      console.warn('// call: sendSignal call_offer failed', e);
    }

    // set timeout for no-answer
    const toId = setTimeout(() => {
      try { if (state.presenceClient) state.presenceClient.sendSignal(to, { type: 'call_end', callId, reason: 'timeout' }); } catch (e) { }
      cleanupCall(callId);
      localToast('Абонент не ответил');
      console.log('// call: timeout cleanup for', callId);
    }, 30000);
    const savedInfo = activeCalls.get(callId) || {};
    savedInfo.timeoutId = toId;
    activeCalls.set(callId, savedInfo);

  } catch (e) {
    console.error('// call: initiateCallTo error', e);
    localToast('Не удалось начать звонок');
  }
}

// Принятие входящего звонка (вызывается при клике "Принять")
async function acceptCall(from, callId) {
  try {
    const info = activeCalls.get(callId) || {};

    // получаем iceServers от сервера (TURN/STUN) — тот же набор, что использовал инициатор
    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });

    // Логи состояний для отладки
    pc.oniceconnectionstatechange = () => console.log('// call: oniceconnectionstatechange', callId, pc.iceConnectionState);
    pc.onconnectionstatechange = () => console.log('// call: onconnectionstatechange', callId, pc.connectionState);
    pc.onicegatheringstatechange = () => console.log('// call: onicegatheringstatechange', callId, pc.iceGatheringState);

    let localStream;
    try {
      localStream = await acquireMic();
      console.log('// call: acquired localStream, audio tracks:', localStream.getAudioTracks());
    } catch (e) {
      localToast('Нужен доступ к микрофону');
      console.warn('// call: getUserMedia failed', e);
      try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'media_denied' }); } catch (e) { }
      cleanupCall(callId);
      return;
    }

    // добавляем локальные треки
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    console.log('// call: added local tracks to pc; pc.getSenders():', pc.getSenders());

    // ICE кандидаты — отправляем в JSON форме и логируем
    pc.onicecandidate = (ev) => {
      if (ev && ev.candidate) {
        try {
          const cand = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
          console.log('// call: sending candidate', callId, cand);
          state.presenceClient.sendSignal(from, { type: 'call_candidate', callId, candidate: cand });
        } catch (err) {
          console.warn('// call: send candidate failed', err);
        }
      }
    };

    // ontrack — воспроизводим remote stream и play()
    pc.ontrack = (ev) => {
      try {
        let audio = document.getElementById('call-audio-' + callId);
        if (!audio) {
          audio = document.createElement('audio');
          audio.id = 'call-audio-' + callId;
          audio.autoplay = true;
          audio.playsInline = true;
          audio.style.display = 'none';
          document.body.appendChild(audio);
        }
        audio.muted = false;
        audio.volume = 1.0;
        const remoteStream = (ev.streams && ev.streams[0]) || ev.stream || null;
        audio.srcObject = remoteStream;
        console.log('// call: ontrack set srcObject', callId, remoteStream);
        audio.play().then(() => {
          console.log('// call: audio.play OK', callId);
        }).catch((err) => {
          console.warn('// call: audio.play failed', callId, err);
        });
      } catch (e) {
        console.error('// call: ontrack handler failed', callId, e);
      }
    };

    // set remote (offer) если есть
    if (!info.offerSdp) {
      console.warn('// call: no offerSdp for callId', callId, 'from', from);
      try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'no_offer' }); } catch (e) { }
      cleanupCall(callId);
      return;
    }

    console.log('// call: setting remoteDescription (offer) for', callId);
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: info.offerSdp }));

    // Если до создания pc приходили кандидаты — применим их
    try {
      if (info.pendingCandidates && info.pendingCandidates.length) {
        console.log('// call: applying', info.pendingCandidates.length, 'pending candidates for', callId);
        for (const cand of info.pendingCandidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
            console.log('// call: applied pending candidate', callId, cand);
          } catch (e) {
            console.warn('// call: failed applying pending candidate', e, cand);
          }
        }
        info.pendingCandidates = [];
      }
    } catch (e) {
      console.warn('// call: pendingCandidates apply step failed', e);
    }

    console.log('// call: remoteDescription set, creating answer', callId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('// call: localDescription (answer) set, local SDP length:', (pc.localDescription && pc.localDescription.sdp && pc.localDescription.sdp.length) || 0);

    // отправляем answer
    try {
      state.presenceClient.sendSignal(from, { type: 'call_answer', callId, sdp: answer.sdp });
      console.log('// call: sent call_answer', callId);
    } catch (e) {
      console.warn('// call: sendSignal call_answer failed', e);
    }

    // обновляем инфо в activeCalls
    info.pc = pc;
    info.localStream = localStream;
    info.role = 'callee';
    activeCalls.set(callId, info);

    // убрать incoming UI
    if (info.uiIds && info.uiIds.incoming) removeUI(info.uiIds.incoming);
    localToast('Звонок принят');
  } catch (e) {
    console.error('// call: acceptCall failed', e);
    localToast('Ошибка при принятии звонка');
    try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'answer_failed' }); } catch (er) { }
    cleanupCall(callId);
  }
}

// Основной обработчик входящих call-сигналов
export async function handleCallSignal(from, payload) {
  try {
    console.log('[call][handle] incoming signal from=', from, 'payload=', payload);
    if (!payload || !payload.type) return;
    const type = payload.type;
    const callId = payload.callId;
    if (!callId) {
      console.warn('[call][handle] no callId in payload', payload);
      return;
    }

    if (type === 'call_offer') {
      const existing = activeCalls.get(callId) || {};
      existing.offerSdp = payload.sdp;
      existing.from = from;
      const uiId = showIncomingUI(from, callId);
      existing.uiIds = existing.uiIds || {};
      existing.uiIds.incoming = uiId;
      // ensure pendingCandidates array exists (in case candidates arrive before accept)
      existing.pendingCandidates = existing.pendingCandidates || [];
      activeCalls.set(callId, existing);
      console.log('[call][handle] stored offer for', callId);
      return;
    }

    if (type === 'call_answer') {
      const info = activeCalls.get(callId);
      if (!info || !info.pc) {
        console.warn('[call][handle] call_answer for unknown call', callId);
        return;
      }
      try {
        await info.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
        if (info.uiIds && info.uiIds.outgoing) removeUI(info.uiIds.outgoing);
        localToast('Звонок подключён');
        if (info.timeoutId) { clearTimeout(info.timeoutId); info.timeoutId = null; activeCalls.set(callId, info); }
        console.log('[call][handle] setRemoteDescription(answer) OK for', callId);
      } catch (e) {
        console.warn('[call][handle] setRemoteDescription(answer) failed', e);
      }
      return;
    }

    if (type === 'call_candidate') {

      // защитимся: игнорируем пустые кандидаты
      if (!payload || !payload.candidate) {
        console.warn('// call: получен пустой candidate, игнорирую', callId);
        return;
      }

      // buffer candidate if pc not created yet
      const info = activeCalls.get(callId) || {};
      if (!info.pc) {
        // store candidate for later applying
        info.pendingCandidates = info.pendingCandidates || [];
        // предотвращаем дублирование одного и того же кандидата
        if (!info.pendingCandidates.find(c => String(c) === String(payload.candidate))) {
          info.pendingCandidates.push(payload.candidate);
        }
        activeCalls.set(callId, info);
        console.log('// call: сохранён pending candidate для', callId);
        return;
      }
      try {
        console.log('// call: добавляю candidate в pc для', callId);
        await info.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (e) {
        console.warn('// call: addIceCandidate не удался', e);
      }
      return;
    }

    if (type === 'call_end') {
      cleanupCall(callId);
      localToast(`Звонок завершён: ${payload.reason || ''}`);
      console.log('[call][handle] call_end for', callId, 'reason=', payload.reason);
      return;
    }

  } catch (e) {
    console.error('handleCallSignal error', e);
  }
}

// Небольшая функция для делегированного навешивания клика на кнопки звонка,
// полезно если не хочешь менять renderUserList: просто вызови attachCallButtonHandler()
export function attachCallButtonHandler(containerSelector = '#userList') {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target && (e.target.closest && e.target.closest('.user-call-btn') || (e.target.classList && e.target.classList.contains('user-call-btn') && e.target));
    if (!btn) return;
    const row = btn.closest && btn.closest('.user-row');
    if (!row) return;
    const userKey = row.getAttribute('data-userkey');
    if (!userKey) return;
    initiateCallTo(userKey);
  });
}
