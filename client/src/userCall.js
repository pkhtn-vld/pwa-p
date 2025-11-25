// Минимальный сигналинг + WebRTC аудио-звонки через ваш presence WS.
// Экспортируем: initiateCallTo(userKey), handleCallSignal(from, payload), attachCallButtonHandler()

import { state } from './state.js';

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
    if (info.pc) try { info.pc.close(); } catch (e) {}
    if (info.localStream) try { info.localStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    if (info.uiIds) {
      if (info.uiIds.incoming) removeUI(info.uiIds.incoming);
      if (info.uiIds.outgoing) removeUI(info.uiIds.outgoing);
    }
  } catch (e) {}
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
  try {
    if (!state.presenceClient) { localToast('Нет WS соединения'); return; }
    const me = (localStorage.getItem('pwaUserName') || '').trim().toLowerCase();
    if (!me) { localToast('Неавторизован'); return; }
    const to = String(userKey).toLowerCase();
    const callId = makeId();
    const outgoingUI = showOutgoingUI(callId, to);

    const pc = new RTCPeerConnection();
    let localStream;
    try {
      localStream = await acquireMic();
    } catch (e) {
      removeUI(outgoingUI);
      localToast('Доступ к микрофону отклонён');
      return;
    }
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        try { state.presenceClient.sendSignal(to, { type: 'call_candidate', callId, candidate: ev.candidate }); } catch (e) {}
      }
    };

    pc.ontrack = (ev) => {
      // простая реализация: создаём аудио элемент
      let audio = document.getElementById('call-audio-' + callId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'call-audio-' + callId;
        audio.autoplay = true;
        audio.style.display = 'none';
        document.body.appendChild(audio);
      }
      audio.srcObject = ev.streams[0];
    };

    // create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    activeCalls.set(callId, { pc, localStream, role: 'caller', to, uiIds: { outgoing: outgoingUI } });

    // send offer via presenceClient
    try {
      state.presenceClient.sendSignal(to, { type: 'call_offer', callId, sdp: offer.sdp });
    } catch (e) {
      console.warn('sendSignal call_offer failed', e);
    }

    // set timeout for no-answer
    const toId = setTimeout(() => {
      try { if (state.presenceClient) state.presenceClient.sendSignal(to, { type: 'call_end', callId, reason: 'timeout' }); } catch (e) {}
      cleanupCall(callId);
      localToast('Абонент не ответил');
    }, 30000);
    const info = activeCalls.get(callId) || {};
    info.timeoutId = toId;
    activeCalls.set(callId, info);

  } catch (e) {
    console.error('initiateCallTo error', e);
    localToast('Не удалось начать звонок');
  }
}

// Принятие входящего звонка (вызывается при клике "Принять")
async function acceptCall(from, callId) {
  try {
    const info = activeCalls.get(callId) || {};
    // создаём pc и local stream
    const pc = new RTCPeerConnection();
    let localStream;
    try {
      localStream = await acquireMic();
    } catch (e) {
      localToast('Нужен доступ к микрофону');
      // уведомим remote
      try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'media_denied' }); } catch (e) {}
      cleanupCall(callId);
      return;
    }
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        try { state.presenceClient.sendSignal(from, { type: 'call_candidate', callId, candidate: ev.candidate }); } catch (e) {}
      }
    };
    pc.ontrack = (ev) => {
      let audio = document.getElementById('call-audio-' + callId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'call-audio-' + callId;
        audio.autoplay = true;
        audio.style.display = 'none';
        document.body.appendChild(audio);
      }
      audio.srcObject = ev.streams[0];
    };

    // set remote (offer) if present
    if (!info.offerSdp) {
      // если offer ещё не пришёл/записан — отклоняем
      localToast('Offer не найден, отклоняю');
      try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'no_offer' }); } catch (e) {}
      cleanupCall(callId);
      return;
    }

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: info.offerSdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // send answer
    try { state.presenceClient.sendSignal(from, { type: 'call_answer', callId, sdp: answer.sdp }); } catch (e) { console.warn('sendSignal call_answer failed', e); }

    // update state
    activeCalls.set(callId, { ...info, pc, localStream, role: 'callee' });
    // remove incoming UI
    if (info.uiIds && info.uiIds.incoming) removeUI(info.uiIds.incoming);
    localToast('Звонок принят');
  } catch (e) {
    console.error('acceptCall failed', e);
    localToast('Ошибка при принятии звонка');
    try { if (state.presenceClient) state.presenceClient.sendSignal(from, { type: 'call_end', callId, reason: 'answer_failed' }); } catch (er) {}
    cleanupCall(callId);
  }
}

// Основной обработчик входящих call-сигналов
export async function handleCallSignal(from, payload) {
  try {
    if (!payload || !payload.type) return;
    const type = payload.type;
    const callId = payload.callId;
    if (!callId) return;

    if (type === 'call_offer') {
      // если уже есть запись — перезапишем offer
      const existing = activeCalls.get(callId) || {};
      existing.offerSdp = payload.sdp;
      // пометим кто звонит
      existing.from = from;
      // создаём incoming UI
      const uiId = showIncomingUI(from, callId);
      existing.uiIds = existing.uiIds || {};
      existing.uiIds.incoming = uiId;
      activeCalls.set(callId, existing);
      return;
    }

    if (type === 'call_answer') {
      // caller получает answer -> установим remoteDescription
      const info = activeCalls.get(callId);
      if (!info || !info.pc) {
        console.warn('call_answer for unknown call', callId);
        return;
      }
      try {
        await info.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
        // remove outgoing UI
        if (info.uiIds && info.uiIds.outgoing) removeUI(info.uiIds.outgoing);
        localToast('Звонок подключён');
        // clear timeout
        if (info.timeoutId) { clearTimeout(info.timeoutId); info.timeoutId = null; activeCalls.set(callId, info); }
      } catch (e) {
        console.warn('setRemoteDescription(answer) failed', e);
      }
      return;
    }

    if (type === 'call_candidate') {
      const info = activeCalls.get(callId);
      if (!info || !info.pc) {
        console.warn('candidate for unknown call', callId);
        return;
      }
      try {
        if (payload.candidate) await info.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (e) {
        console.warn('addIceCandidate failed', e);
      }
      return;
    }

    if (type === 'call_end') {
      cleanupCall(callId);
      localToast(`Звонок завершён: ${payload.reason || ''}`);
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
