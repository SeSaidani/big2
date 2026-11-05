// Browser client for the online server: JSON calls and the event stream.
// The cookie holds the session, so nothing secret is ever kept in JavaScript.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* an error page, not JSON */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  config: () => call('GET', '/api/config'),
  me: () => call('GET', '/api/me'),
  register: (name, password) => call('POST', '/api/register', { name, password }),
  login: (name, password) => call('POST', '/api/login', { name, password }),
  // Turn alerts: the sender's public key and my devices; add or remove this device; send myself a test.
  push: () => call('GET', '/api/push'),
  pushSubscribe: (subscription, label) => call('POST', '/api/push/subscribe', { subscription, label }),
  pushUnsubscribe: (endpoint) => call('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: () => call('POST', '/api/push/test', {}),
  logout: () => call('POST', '/api/logout', {}),
  changePassword: (current, next) => call('POST', '/api/password', { current, next }),
  // season: 'current' | 'all' | a season id; sort: 'points' | 'perGame'. Games with computer players never count.
  leaderboard: (season = 'current', sort = 'points') =>
    call(
      'GET',
      `/api/leaderboard?season=${encodeURIComponent(season)}&sort=${sort === 'perGame' ? 'perGame' : 'points'}`,
    ),
  // luck and play against what the dealt cards were worth (same season choice as the leaderboard)
  stats: (season = 'current') => call('GET', `/api/stats?season=${encodeURIComponent(season)}`),
  seasons: () => call('GET', '/api/seasons'),
  game: () => call('GET', '/api/game'),
  // The one game
  createGame: (aiLevel, seats) => call('POST', '/api/game', { aiLevel, seats }),
  join: () => call('POST', '/api/game/join'),
  leave: () => call('POST', '/api/game/leave'),
  start: () => call('POST', '/api/game/start'),
  move: (cards) => call('POST', '/api/game/move', { cards }),
  say: (text) => call('POST', '/api/game/chat', { text }),
  // Admin
  admin: {
    overview: () => call('GET', '/api/admin/overview'),
    users: () => call('GET', '/api/admin/users'),
    audit: () => call('GET', '/api/admin/audit?limit=30'),
    createUser: (name, password, isAdmin) => call('POST', '/api/admin/users', { name, password, isAdmin }),
    resetPassword: (id, password) => call('POST', `/api/admin/users/${id}/password`, { password }),
    setDisabled: (id, disabled) => call('POST', `/api/admin/users/${id}/status`, { disabled }),
    setAdmin: (id, isAdmin) => call('POST', `/api/admin/users/${id}/role`, { isAdmin }),
    setRegistration: (registrationOpen) => call('POST', '/api/admin/settings', { registrationOpen }),
    createSeason: (name, starts, ends) => call('POST', '/api/admin/seasons', { name, starts, ends }),
    updateSeason: (id, name, starts, ends) => call('POST', `/api/admin/seasons/${id}`, { name, starts, ends }),
    deleteSeason: (id) => call('POST', `/api/admin/seasons/${id}/delete`, {}),
    endSeason: (id) => call('POST', `/api/admin/seasons/${id}/end`, {}),
    cancelGame: () => call('POST', '/api/admin/game/cancel', {}),
  },
};

// EventSource reconnects by itself, and the server re-sends the current table
// view (and chat history) on every (re)connect, so a dropped connection loses
// nothing.
export function connect({ onLobby, onTable, onChat, onChatHistory, onOpen, onError }) {
  const es = new EventSource('/api/events');
  es.onopen = () => onOpen();
  es.addEventListener('lobby', (e) => onLobby(JSON.parse(e.data)));
  es.addEventListener('table', (e) => onTable(JSON.parse(e.data)));
  es.addEventListener('chat', (e) => onChat(JSON.parse(e.data)));
  es.addEventListener('chathistory', (e) => onChatHistory(JSON.parse(e.data)));
  es.onerror = () => onError();
  return es;
}
