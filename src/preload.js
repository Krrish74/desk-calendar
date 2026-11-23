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
  platform: process.platform, // 'win32' or 'darwin': the page adapts its title bar and wording
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
  // Google Tasks
  tasksStatus: call('tasks:status'),
  connectTasks: call('tasks:connect'),
  getTaskLists: call('tasks:lists'),
  setTaskListVisible: call('tasks:setListVisible'),
  getTasks: call('tasks:list'),
  createTask: call('tasks:create'),
  updateTask: call('tasks:update'),
  deleteTaskLater: call('tasks:deleteLater'),
  parseTask: call('tasks:parse'),
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
  // settings shared with the phone app (sync.js)
  syncStatus: call('sync:status'),
  syncSetUrl: call('sync:setUrl'),
  syncNow: call('sync:now'),
  // backend → page notifications
  onEventsChanged: (fn) => ipcRenderer.on('events:changed', () => fn()),
  onPrefsChanged: (fn) => ipcRenderer.on('prefs:changed', (_e, keys) => fn(keys)), // changed on the phone
  onCommand: (fn) => ipcRenderer.on('app:command', (_e, name, payload) => fn(name, payload)), // tray menu, notifications
  onFullscreen: (fn) => ipcRenderer.on('app:fullscreen', (_e, on) => fn(on)), // Mac full screen
});
