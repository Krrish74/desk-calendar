// api.js: every call to the Worker goes through here.
//
// The phone never talks to Google or Claude directly: it asks the Worker (same
// address, /api/*), which holds the tokens and keys. The session cookie is sent
// automatically by the browser (it's HttpOnly, so scripts here can't even read it).
//
// Each request carries:
//   X-Time-Zone     the iPhone's time zone, so "tomorrow 6pm" means YOUR tomorrow
//   X-Desk-Calendar  on changes (POST/PATCH): proves the request came from this app,
//                    not from another website (see index.js in the Worker)
// Errors come back as { error, code }; NOT_SIGNED_IN shows the sign-in screen.

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let onSignedOut = () => {};
export const setSignedOutHandler = (fn) => { onSignedOut = fn; };
let onOffline = () => {};
export const setOfflineHandler = (fn) => { onOffline = fn; };

/** Forget the calendar data the service worker saved for offline use (on sign-out). */
export async function clearOfflineData() {
  navigator.serviceWorker?.controller?.postMessage('clear-data');
  try { await caches.delete('dc-data'); } catch { /* no Cache Storage (old browser / private mode) */ }
}

async function call(method, path, body) {
  const headers = { 'X-Time-Zone': timeZone };
  if (method !== 'GET') headers['X-Desk-Calendar'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError("Can't reach Desk Calendar. Check your connection.", 0, 'OFFLINE');
  }
  // The service worker answers from its saved copy when there's no network (see sw.js).
  if (res.headers.get('X-Desk-Offline') === '1') onOffline();
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data?.code);
    if (err.code === 'NOT_SIGNED_IN') onSignedOut(err.message);
    throw err;
  }
  return data;
}

const q = (params) => new URLSearchParams(params).toString();

export const api = {
  me: () => call('GET', '/api/me'),
  setPrefs: (changes) => call('PATCH', '/api/prefs', changes),
  calendars: (fresh = false) => call('GET', `/api/calendars${fresh ? '?fresh=1' : ''}`),
  setCalendarVisible: (id, visible) => call('PATCH', '/api/calendars/visibility', { id, visible }),
  events: (start, end) => call('GET', `/api/events?${q({ start: start.toISOString(), end: end.toISOString() })}`),
  createEvent: (ev) => call('POST', '/api/events', ev),
  updateEvent: (ev) => call('PATCH', '/api/events', ev),
  deleteLater: (calendarId, eventId) => call('POST', '/api/events/delete', { calendarId, eventId }),
  undoDelete: (token) => call('POST', '/api/events/undo', { token }),
  parseQuick: (text) => call('POST', '/api/quick/parse', { text }),
  quickAdd: (text) => call('POST', '/api/quick/add', { text }),
  chat: (text) => call('POST', '/api/chat', { text }),
  chatReset: () => call('POST', '/api/chat/reset', {}),
  chatModels: () => call('GET', '/api/chat/models'),
  signOut: (everywhere = false) => call('POST', '/auth/logout', { everywhere }),
  assistantSettings: () => call('GET', '/api/chat/models'), // models, About-you profile, spending
  // Google Tasks (from/to are 'YYYY-MM-DD'; to is exclusive)
  tasks: ({ from, to, overdue = false, undated = false, completed = true }) =>
    call('GET', `/api/tasks?${q({ from, to, overdue: overdue ? 1 : 0, undated: undated ? 1 : 0, completed: completed ? 1 : 0 })}`),
  taskLists: (fresh = false) => call('GET', `/api/tasks/lists${fresh ? '?fresh=1' : ''}`),
  setTaskListVisible: (id, visible) => call('PATCH', '/api/tasks/lists/visibility', { id, visible }),
  createTask: (t) => call('POST', '/api/tasks', t),
  updateTask: (t) => call('PATCH', '/api/tasks', t),
  deleteTaskLater: (listId, taskId) => call('POST', '/api/tasks/delete', { listId, taskId }),
  parseTask: (text) => call('POST', '/api/tasks/parse', { text }),
  pushSubscribe: (subscription) => call('POST', '/api/push/subscribe', subscription),
  pushUnsubscribe: (endpoint) => call('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: () => call('POST', '/api/push/test', {}),
};
