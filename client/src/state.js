// --- централизованное mutable state для клиента

export const state = {
  // WebSocket / presence клиент (createPresenceClient() возвращает объект)
  presenceClient: null,

  // текущий открытый чат: { userKey, displayName, messages: [] } или null
  currentChat: null,

  // сет онлайн пользователей (Set of lowercased userKeys)
  onlineSet: new Set(),

  // userKey текущего открытого чата (lowercased) — удобно для быстрых проверок
  currentOpenChatUserKey: null,
};

export function setPresenceClient(pc) {
  state.presenceClient = pc;
}
export function getPresenceClient() {
  return state.presenceClient;
}
