// Минимальный сигналинг + WebRTC аудио-звонки через ваш presence WS.
// Экспортируем: initiateCallTo(userKey), handleCallSignal(from, payload), attachCallButtonHandler()

import { state } from './state.js';


// // comment: вспомогательная функция для отправки структурированных логов на сервер
function _sendClientCallLog(kind, data) {
  try {
    const payload = {
      ts: new Date().toISOString(),
      src: 'client-userCall',
      kind,
      data
    };
    // // comment: лог в консоль (для локальной отладки)
    console.log('// call: client-log', kind, data);
    // // comment: отправим на сервер, не дожидаемся ответа
    fetch('/debug/log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {/* ignore */ });
  } catch (e) { /* ignore */ }
}

// comment: запрашиваем защищённый маршрут /get-turn-credentials (требует авторизации)
async function getIceServers() {
  // // comment: запрашиваем ICE-серверы у сервера и подробно логируем результат.
  try {
    console.log('// call: запрашиваю ICE-серверы с /get-turn-credentials');
    // // comment: посылаем короткий диагностический заголовок, сервер может логировать запрос
    const resp = await fetch('/get-turn-credentials', {
      credentials: 'include',
      headers: { 'X-Debug-Call': '1' }
    });
    // // comment: логируем HTTP статус
    console.log(`// call: /get-turn-credentials статус=${resp.status}`);
    let body = null;
    try { body = await resp.clone().json(); } catch (e) { body = await resp.text().catch(() => null); }
    // // comment: логируем тело ответа в консоль
    console.log('// call: /get-turn-credentials ответ body=', body);

    // // comment: отправляем диагностический лог на сервер, чтобы его можно было собрать централизовано
    try {
      fetch('/debug/log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ts: new Date().toISOString(),
          src: 'client-getIceServers',
          status: resp.status,
          body: body
        })
      }).catch(() => {/* ignore */ });
    } catch (e) { /* ignore */ }

    if (!resp.ok) {
      console.warn('// call: /get-turn-credentials вернул не OK, использую fallback STUN');
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    const json = (typeof body === 'object' ? body : null);
    if (!json || !Array.isArray(json.iceServers) || json.iceServers.length === 0) {
      console.log('// call: пустой список iceServers от сервера — использую fallback STUN');
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    console.log('// call: получил iceServers, count=', json.iceServers.length);
    return json.iceServers;
  } catch (e) {
    console.warn('// call: ошибка при запросе iceServers, использую fallback STUN', e);
    try {
      fetch('/debug/log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: new Date().toISOString(), src: 'client-getIceServers-error', error: String(e) })
      }).catch(() => {/* ignore */ });
    } catch (er) { }
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
    setTimeout(() => { try { el.style.display = 'none'; } catch (e) { } }, 3000);
  } catch (e) { console.log(text); }
}

const activeCalls = new Map(); // callId -> { pc, localStream, role, to/from, offerSdp, uiIds }

// утилита
function makeId() { return String(Math.random()).slice(2, 10) + '-' + Date.now(); }

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
    try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'rejected' }); } catch (e) { }
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

function removeUI(id) { const el = document.getElementById(id); if (el) try { el.remove(); } catch (e) { } }

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
        try { audioEl.srcObject = null; } catch (e) { }
        try { audioEl.remove(); } catch (e) { }
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
      try { info.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) { } }); } catch (e) { }
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
  // // comment: инициируем звонок и логируем каждый важный шаг и ошибку
  console.log('// call: enter initiateCallTo userKey=', userKey);
  _sendClientCallLog('initiate_start', { to: userKey });

  try {
    if (!state.presenceClient) {
      console.warn('// call: нет state.presenceClient');
      _sendClientCallLog('error', { reason: 'no_presence_client' });
      localToast('Нет WS соединения');
      return;
    }
    const me = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();
    if (!me) {
      console.warn('// call: неавторизован');
      _sendClientCallLog('error', { reason: 'not_authenticated' });
      localToast('Неавторизован');
      return;
    }
    const to = String(userKey).toLowerCase();
    const callId = makeId();
    const outgoingUI = showOutgoingUI(callId, to);
    _sendClientCallLog('create_call', { callId, to, me });

    const iceServers = await getIceServers();
    _sendClientCallLog('ice_servers', { callId, iceServers });

    const pc = new RTCPeerConnection({ iceServers });

    // // comment: логируем состояния соединения
    pc.oniceconnectionstatechange = () => {
      console.log(`// call: oniceconnectionstatechange ${callId} ${pc.iceConnectionState}`);
      _sendClientCallLog('iceconnectionstate', { callId, state: pc.iceConnectionState });
    };
    pc.onconnectionstatechange = () => {
      console.log(`// call: onconnectionstatechange ${callId} ${pc.connectionState}`);
      _sendClientCallLog('connectionstate', { callId, state: pc.connectionState });
    };
    pc.onicegatheringstatechange = () => {
      console.log(`// call: onicegatheringstatechange ${callId} ${pc.iceGatheringState}`);
      _sendClientCallLog('icegatheringstate', { callId, state: pc.iceGatheringState });
    };

    let localStream;
    try {
      localStream = await acquireMic();
      console.log('// call: acquired localStream, audio tracks:', localStream.getAudioTracks());
      _sendClientCallLog('media_acquired', { callId, tracks: localStream.getAudioTracks().map(t => ({ kind: t.kind, id: t.id, enabled: t.enabled })) });
    } catch (e) {
      removeUI(outgoingUI);
      localToast('Доступ к микрофону отклонён');
      console.warn('// call: getUserMedia failed', e);
      _sendClientCallLog('error', { callId, reason: 'getUserMedia_failed', err: String(e) });
      return;
    }

    // // comment: добавляем локальные треки и логируем senders
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    console.log('// call: added local tracks to pc; pc.getSenders():', pc.getSenders());
    _sendClientCallLog('tracks_added', { callId, senders: pc.getSenders().map(s => ({ id: s.track && s.track.id })) });

    // // comment: ontrack — воспроизводим удалённый поток и логируем play и события аудиоэлемента
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
        _sendClientCallLog('ontrack', { callId, remoteStreamTracks: (remoteStream && remoteStream.getTracks().map(t => ({ id: t.id, kind: t.kind }))) });
        audio.addEventListener('canplay', () => {
          console.log('// call: audio canplay', callId);
          _sendClientCallLog('audio_event', { callId, event: 'canplay' });
        }, { once: true });
        audio.addEventListener('error', (err) => {
          console.warn('// call: audio element error', callId, err);
          _sendClientCallLog('audio_event', { callId, event: 'error', error: String(err) });
        });
        audio.play().then(() => {
          console.log('// call: audio.play OK', callId);
          _sendClientCallLog('audio_play', { callId, ok: true });
        }).catch((err) => {
          console.warn('// call: audio.play failed', callId, err);
          _sendClientCallLog('audio_play', { callId, ok: false, error: String(err) });
        });
      } catch (e) {
        console.error('// call: ontrack handler failed', callId, e);
        _sendClientCallLog('error', { callId, where: 'ontrack_handler', err: String(e) });
      }
    };

    // // comment: ICE кандидаты — отправляем и журналируем
    pc.onicecandidate = (ev) => {
      if (ev && ev.candidate) {
        try {
          const cand = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
          console.log('// call: sending candidate', callId, cand);
          _sendClientCallLog('local_candidate', { callId, candidate: cand });
          state.presenceClient.sendSignal(to, { type: 'call_candidate', callId, candidate: cand });
        } catch (err) {
          console.warn('// call: send candidate failed', err);
          _sendClientCallLog('error', { callId, where: 'send_candidate', err: String(err) });
        }
      }
    };

    // // comment: create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log('// call: created offer, local SDP length:', (pc.localDescription && pc.localDescription.sdp && pc.localDescription.sdp.length) || 0);
    _sendClientCallLog('offer_created', { callId, sdpLen: (pc.localDescription && pc.localDescription.sdp && pc.localDescription.sdp.length) || 0 });

    const info = { pc, localStream, role: 'caller', to, uiIds: { outgoing: outgoingUI } };
    activeCalls.set(callId, info);

    try {
      state.presenceClient.sendSignal(to, { type: 'call_offer', callId, sdp: offer.sdp });
      console.log('// call: sent call_offer', callId, 'to', to);
      _sendClientCallLog('offer_sent', { callId, to });
    } catch (e) {
      console.warn('// call: sendSignal call_offer failed', e);
      _sendClientCallLog('error', { callId, where: 'send_offer', err: String(e) });
    }

    // // comment: таймаут и периодический сбор getStats для мониторинга RTP
    const toId = setTimeout(() => {
      try { if (state.presenceClient) state.presenceClient.sendSignal(to, { type: 'call_end', callId, reason: 'timeout' }); } catch (e) { }
      cleanupCall(callId);
      localToast('Абонент не ответил');
      console.log('// call: timeout cleanup for', callId);
      _sendClientCallLog('timeout', { callId });
    }, 30000);

    // // comment: собираем getStats каждые 2 сек для debug, отправляем summary на сервер
    const statsInterval = setInterval(async () => {
      try {
        if (!pc) return;
        const s = await pc.getStats();
        const result = [];
        s.forEach(r => {
          if (r.type && (r.type === 'outbound-rtp' || r.type === 'inbound-rtp' || r.type === 'candidate-pair' || r.type === 'remote-inbound-rtp')) {
            result.push(r);
          }
        });
        _sendClientCallLog('getStats', { callId, statsSample: result.slice(0, 10) }); // slice чтобы не шлать всё
      } catch (e) {
        // ignore
      }
    }, 2000);

    const savedInfo = activeCalls.get(callId) || {};
    savedInfo.timeoutId = toId;
    savedInfo.statsIntervalId = statsInterval;
    activeCalls.set(callId, savedInfo);

  } catch (e) {
    console.error('// call: initiateCallTo error', e);
    _sendClientCallLog('error', { where: 'initiateCallTo_top', err: String(e) });
    localToast('Не удалось начать звонок');
  }
}

// Принятие входящего звонка (вызывается при клике "Принять")
export async function acceptCall(from, callId) {
  // // comment: принять входящий звонок, логируем шаги
  _sendClientCallLog('accept_start', { from, callId });
  try {
    const info = activeCalls.get(callId) || {};
    const iceServers = await getIceServers();
    _sendClientCallLog('ice_servers', { callId, iceServers });

    const pc = new RTCPeerConnection({ iceServers });

    pc.oniceconnectionstatechange = () => {
      console.log('// call: oniceconnectionstatechange', callId, pc.iceConnectionState);
      _sendClientCallLog('iceconnectionstate', { callId, state: pc.iceConnectionState });
    };
    pc.onconnectionstatechange = () => {
      console.log('// call: onconnectionstatechange', callId, pc.connectionState);
      _sendClientCallLog('connectionstate', { callId, state: pc.connectionState });
    };
    pc.onicegatheringstatechange = () => {
      console.log('// call: onicegatheringstatechange', callId, pc.iceGatheringState);
      _sendClientCallLog('icegatheringstate', { callId, state: pc.iceGatheringState });
    };

    let localStream;
    try {
      localStream = await acquireMic();
      _sendClientCallLog('media_acquired', { callId, tracks: localStream.getAudioTracks().map(t => ({ id: t.id, enabled: t.enabled })) });
    } catch (e) {
      localToast('Нужен доступ к микрофону');
      console.warn('// call: getUserMedia failed', e);
      _sendClientCallLog('error', { callId, reason: 'getUserMedia_failed', err: String(e) });
      try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'media_denied' }); } catch (e) { }
      cleanupCall(callId);
      return;
    }

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    _sendClientCallLog('tracks_added', { callId, senders: pc.getSenders().map(s => ({ id: s.track && s.track.id })) });

    pc.onicecandidate = (ev) => {
      if (ev && ev.candidate) {
        try {
          const cand = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
          console.log('// call: sending candidate', callId, cand);
          _sendClientCallLog('local_candidate', { callId, candidate: cand });
          state.presenceClient.sendSignal(from, { type: 'call_candidate', callId, candidate: cand });
        } catch (err) {
          console.warn('// call: send candidate failed', err);
          _sendClientCallLog('error', { callId, where: 'send_candidate', err: String(err) });
        }
      }
    };

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
        _sendClientCallLog('ontrack', { callId, remoteStreamTracks: (remoteStream && remoteStream.getTracks().map(t => ({ id: t.id, kind: t.kind }))) });
        audio.play().then(() => _sendClientCallLog('audio_play', { callId, ok: true })).catch(err => _sendClientCallLog('audio_play', { callId, ok: false, error: String(err) }));
      } catch (e) {
        console.error('// call: ontrack handler failed', callId, e);
        _sendClientCallLog('error', { callId, where: 'ontrack', err: String(e) });
      }
    };

    if (!info.offerSdp) {
      console.warn('// call: no offerSdp for callId', callId, 'from', from);
      _sendClientCallLog('error', { callId, reason: 'no_offer' });
      try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'no_offer' }); } catch (e) { }
      cleanupCall(callId);
      return;
    }

    _sendClientCallLog('setting_remote_offer', { callId });
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: info.offerSdp }));

    if (info.pendingCandidates && info.pendingCandidates.length) {
      console.log('// call: applying', info.pendingCandidates.length, 'pending candidates for', callId);
      _sendClientCallLog('applying_pending_candidates', { callId, count: info.pendingCandidates.length });
      for (const cand of info.pendingCandidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
          _sendClientCallLog('applied_candidate', { callId, candidate: cand });
        } catch (e) {
          console.warn('// call: failed applying pending candidate', e, cand);
          _sendClientCallLog('error', { callId, where: 'apply_pending_candidate', err: String(e), candidate: cand });
        }
      }
      info.pendingCandidates = [];
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('// call: localDescription (answer) set, local SDP length:', (pc.localDescription && pc.localDescription.sdp && pc.localDescription.sdp.length) || 0);
    _sendClientCallLog('answer_created', { callId, sdpLen: (pc.localDescription && pc.localDescription.sdp && pc.localDescription.sdp.length) || 0 });

    try {
      state.presenceClient.sendSignal(from, { type: 'call_answer', callId, sdp: answer.sdp });
      console.log('// call: sent call_answer', callId);
      _sendClientCallLog('answer_sent', { callId, to: from });
    } catch (e) {
      console.warn('// call: sendSignal call_answer failed', e);
      _sendClientCallLog('error', { callId, where: 'send_answer', err: String(e) });
    }

    info.pc = pc;
    info.localStream = localStream;
    info.role = 'callee';
    activeCalls.set(callId, info);

    if (info.uiIds && info.uiIds.incoming) removeUI(info.uiIds.incoming);
    localToast('Звонок принят');
  } catch (e) {
    console.error('// call: acceptCall failed', e);
    _sendClientCallLog('error', { where: 'acceptCall_top', err: String(e) });
    localToast('Ошибка при принятии звонка');
    try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'answer_failed' }); } catch (er) { }
    cleanupCall(callId);
  }
}

// Основной обработчик входящих call-сигналов
export async function handleCallSignal(from, payload) {
  try {
    console.log('[call][handle] incoming signal from=', from, 'payload=', payload);
    _sendClientCallLog('handle_incoming', { from, payload });
    if (!payload || !payload.type) return;
    const type = payload.type;
    const callId = payload.callId;
    if (!callId) {
      console.warn('[call][handle] no callId in payload', payload);
      _sendClientCallLog('error', { where: 'handle_no_callId', payload });
      return;
    }
    if (type === 'call_offer') {
      const existing = activeCalls.get(callId) || {};
      existing.offerSdp = payload.sdp;
      existing.from = from;
      const uiId = showIncomingUI(from, callId);
      existing.uiIds = existing.uiIds || {};
      existing.uiIds.incoming = uiId;
      existing.pendingCandidates = existing.pendingCandidates || [];
      activeCalls.set(callId, existing);
      console.log('[call][handle] stored offer for', callId);
      _sendClientCallLog('offer_received', { callId, from, sdpLen: payload.sdp && payload.sdp.length });
      return;
    }
    if (type === 'call_answer') {
      const info = activeCalls.get(callId);
      if (!info || !info.pc) {
        console.warn('[call][handle] call_answer for unknown call', callId);
        _sendClientCallLog('error', { where: 'answer_unknown_call', callId });
        return;
      }
      try {
        await info.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
        if (info.uiIds && info.uiIds.outgoing) removeUI(info.uiIds.outgoing);
        localToast('Звонок подключён');
        if (info.timeoutId) { clearTimeout(info.timeoutId); info.timeoutId = null; activeCalls.set(callId, info); }
        console.log('[call][handle] setRemoteDescription(answer) OK for', callId);
        _sendClientCallLog('answer_applied', { callId });
      } catch (e) {
        console.warn('[call][handle] setRemoteDescription(answer) failed', e);
        _sendClientCallLog('error', { where: 'setRemoteDescription_answer', callId, err: String(e) });
      }
      return;
    }
    if (type === 'call_candidate') {
      const info = activeCalls.get(callId) || {};
      if (!info.pc) {
        info.pendingCandidates = info.pendingCandidates || [];
        info.pendingCandidates.push(payload.candidate);
        activeCalls.set(callId, info);
        console.log('[call][handle] saved pending candidate for', callId, payload.candidate);
        _sendClientCallLog('pending_candidate_saved', { callId, candidate: payload.candidate });
        return;
      }
      try {
        console.log('[call][handle] adding candidate for', callId, payload.candidate);
        await info.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        _sendClientCallLog('remote_candidate_added', { callId, candidate: payload.candidate });
      } catch (e) {
        console.warn('[call][handle] addIceCandidate failed', e);
        _sendClientCallLog('error', { where: 'addIceCandidate', callId, err: String(e) });
      }
      return;
    }
    if (type === 'call_end') {
      cleanupCall(callId);
      localToast(`Звонок завершён: ${payload.reason || ''}`);
      console.log('[call][handle] call_end for', callId, 'reason=', payload.reason);
      _sendClientCallLog('call_end', { callId, reason: payload.reason });
      return;
    }
  } catch (e) {
    console.error('handleCallSignal error', e);
    _sendClientCallLog('error', { where: 'handleCallSignal_top', err: String(e) });
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
