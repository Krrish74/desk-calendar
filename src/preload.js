// preload.js: the bridge between the page (renderer) and the backend (main).
//
// It runs before the page loads and puts ONE object on the page: `window.desk`.
// Each function just sends a named IPC message to main.js and returns the reply.
// The page gets no other way to reach Node, Google tokens or the filesystem.
//
// To add a feature: add a handler in main.js with `handle('x:y', ...)`, then a
// line here, then call `desk.whatever()` from app.js.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('desk', {
  // auth
  authStatus: call('auth:status'),
  importCredentials: call('auth:importCredentials'),
  signIn: call('auth:signIn'),
  signOut: call('auth:signOut'),
  account: call('auth:account'),
  // calendar
  getEvents: call('cal:events'),
  getCalendars: call('cal:calendars'),
  setCalendarVisible: call('cal:setVisible'),
  createEvent: call('cal:create'),
  updateEvent: call('cal:update'),
  deleteEvent: call('cal:delete'),
  deleteLater: call('cal:deleteLater'),   // delete after the Undo window
  undoDelete: call('cal:undoDelete'),
  // quick add
  parseQuick: call('quick:parse'),
  quickAdd: call('quick:add'),
  // chatbot
  chatSend: call('chat:send'),
  chatReset: call('chat:reset'),
  chatKeyStatus: call('chat:keyStatus'),
  chatSetKey: call('chat:setKey'),
  chatSettings: call('chat:settings'),
  chatSetSettings: call('chat:setSettings'),
  chatFetchModels: call('chat:fetchModels'),
  // window
  togglePin: call('win:togglePin'),
  isPinned: call('win:isPinned'),
  openUrl: call('open:url'),
  // preferences
  getPrefs: call('prefs:get'),
  notifyTest: call('notify:test'),
  setPrefs: call('prefs:set'),
  // backend → page notifications
  onEventsChanged: (fn) => ipcRenderer.on('events:changed', () => fn()),
  onCommand: (fn) => ipcRenderer.on('app:command', (_e, name, payload) => fn(name, payload)), // tray menu, notifications
});
