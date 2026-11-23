// main.js: the Electron "main process". It's the app's backend.
//
// Electron apps have two halves:
//   • MAIN process (this folder, src/main): full Node.js. Talks to Google and Claude,
//     reads/writes files, owns the window. Secrets live only here.
//   • RENDERER process (src/renderer): the web page you see. It's sandboxed: no
//     Node, no file access, no tokens. It can only call the handful of functions
//     that preload.js exposes, which send messages here over IPC
//     (inter-process communication).
// This split means even if something odd got into the page (say, a malicious event
// title), it can't reach your tokens or your filesystem.

const { app, ipcMain, dialog, shell } = require('electron');
const auth = require('./auth');
const calendar = require('./calendar');
const quickadd = require('./quickadd');
const assistant = require('./assistant');
const tasks = require('./tasks');
const prefs = require('./prefs');
const windowManager = require('./windowManager');
const background = require('./background');
const notifier = require('./notifier');
const { createSync } = require('./sync');
const { checkSettingsPage } = require('./prefcheck');
const path = require('path');

// The window lives in windowManager.js; tray, hotkey and start-with-Windows in background.js.
const win = () => windowManager.get();
let hotkeyStatus = { ok: true }; // shown in Settings if the hotkey couldn't be registered

// Only one copy of the app at a time; launching again just brings the window forward.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => windowManager.show());

// Any real quit (tray → Quit, Cmd+Q) must not be turned into "hide". Deletes still inside
// their Undo window, and deletes already on their way to Google, are finished first (for at
// most a few seconds, so a hung request can't stop the app from quitting).
const QUIT_WAIT_MS = 5000;
let quitReady = false;
app.on('before-quit', (e) => {
  windowManager.setQuitting();
  if (quitReady) return;
  // An assistant delete whose reply never arrived has no timer yet: it's dropped, the item stays.
  for (const [token, p] of pendingDeletes) if (!p.timer) cancelDelete(token);
  if (!pendingDeletes.size && !inFlightDeletes.size) return;
  e.preventDefault();
  const timeout = new Promise((r) => setTimeout(r, QUIT_WAIT_MS));
  Promise.race([flushDeletes(), timeout]).finally(() => { quitReady = true; app.quit(); });
});

// Windows needs this ID to show our notifications with the right name and icon.
// (Windows-only API: it doesn't exist on macOS.)
if (process.platform === 'win32') app.setAppUserModelId('com.local.deskcalendar');

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    require('./menu').setMacMenu();
    // Running from source, the Dock would show Electron's icon; the built app has its own.
    if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon-512.png'));
  }
  // Silently reuse the saved Google token, if any. Awaited so the page's first
  // "am I signed in?" check sees the restored session.
  await auth.restoreSession().catch((err) => console.error('Restoring session failed:', err.message));
  // Started by Windows at sign-in? Then stay in the tray if that preference is on.
  windowManager.create({ startHidden: background.launchedAtLogin() && prefs.get('startHidden') });
  hotkeyStatus = background.start().hotkey;
  notifier.start();
  // Settings shared with the phone app (sync.js): check now, every few minutes, and
  // whenever the window comes forward.
  phoneSync.start();
  windowManager.get()?.on('focus', () => phoneSync.onFocus());
  // Windows shutdown / sign-out doesn't send before-quit: finish pending deletes now.
  windowManager.get()?.on('session-end', () => { flushDeletes(); });
  notifier.setHiddenCheck((calendarId, eventId) => pendingDeleteKeys().has(`${calendarId}|${eventId}`));
});

// Closing the window only hides it, so the app keeps running until Quit in the tray.
app.on('window-all-closed', () => {});
// Mac: clicking the Dock icon (or opening the app again from Finder) brings the window back.
app.on('activate', () => windowManager.show());

// ---------------------------------------------------------------------------
// IPC handlers: the ONLY things the page can ask the backend to do.
// ---------------------------------------------------------------------------

/**
 * Wrap a handler so errors come back as { error, code } instead of crashing.
 * If Google says our refresh token is dead ("invalid_grant": revoked, or the
 * 7-day Testing-mode expiry), we drop it so the UI shows "Sign in" again.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    // Only the app's own page may call the backend (see windowManager.js: the window can't
    // be navigated anywhere else, and this is the second lock on that door).
    if (!windowManager.isAppPage(event.senderFrame?.url)) return { error: 'Not allowed.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      const msg = err?.response?.data?.error_description || err?.message || String(err);
      // Google's code for a dead sign-in ("invalid_grant") can be in error, error_description
      // or the message, depending on the library version: check all of them.
      const googleCode = `${err?.response?.data?.error || ''} ${err?.message || ''} ${msg}`;
      if (err?.code === 'NOT_SIGNED_IN' || /invalid_grant|invalid_rapt/.test(googleCode)) {
        await auth.signOut().catch(() => {});
        clearCaches();
        return { error: 'Your Google sign-in expired. Please sign in again.', code: 'NOT_SIGNED_IN' };
      }
      console.error(`[${channel}]`, msg);
      // Tasks permission / API problems carry a code so the page can offer the fix.
      return /^TASKS_/.test(err?.code) ? { error: msg, code: err.code } : { error: msg };
    }
  });
}

/** Calendar and task-list caches belong to one Google account. */
function clearCaches() { calendar.clearCache(); tasks.clearCache(); }

// Tell the page to reload its events (used after the chatbot changes something),
// and let the notification scheduler re-fetch upcoming events.
const notifyChanged = () => { win()?.webContents.send('events:changed'); notifier.invalidate(); };

// --- Settings shared with the phone app (see sync.js) ---
const phoneSync = createSync({
  prefs,
  getToken: async () => (await auth.getClient().getAccessToken()).token,
  // The phone changed something: redraw with it (and re-check reminder times).
  onApplied: (keys) => {
    win()?.webContents.send('prefs:changed', keys);
    if (keys.includes('notifyMinutes')) notifier.invalidate();
  },
});
prefs.onChange((changes) => phoneSync.onLocalChange(changes));
handle('sync:status', () => phoneSync.status());
handle('sync:setUrl', (url) => phoneSync.setUrl(url));
handle('sync:now', () => phoneSync.syncNow());

// --- auth ---
handle('auth:status', () => ({ hasCredentials: auth.hasCredentials(), signedIn: auth.isSignedIn() }));
handle('auth:importCredentials', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win(), {
    title: 'Choose the credentials.json you downloaded from Google Cloud',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled) return false;
  auth.importCredentials(filePaths[0]);
  return true;
});
handle('auth:signIn', async () => { const r = await auth.signIn(); clearCaches(); phoneSync.syncNow(); return r; });
handle('auth:signOut', async () => { await auth.signOut(); clearCaches(); });
// Your Google account's email: the ID of your primary calendar is your address.
handle('auth:account', async () => (await calendar.listCalendars()).find((c) => c.primary)?.id || '');

// --- calendar ---
// Events in [startISO, endISO) from every visible calendar. The page asks for
// whatever range the current view shows, plus today/tomorrow for the countdown.
handle('cal:events', async (startISO, endISO) => {
  const events = await calendar.listEvents(new Date(startISO), new Date(endISO));
  // Events waiting out their "Undo" window stay hidden even though Google still has them.
  return events.filter((e) => !pendingDeleteKeys().has(`${e.calendarId}|${e.id}`));
});
handle('cal:calendars', () => calendar.listCalendars());
handle('cal:setVisible', (id, visible) => calendar.setCalendarVisible(id, visible));
handle('cal:create', async (ev) => { const r = await calendar.createEvent(ev); notifier.invalidate(); return r; });
handle('cal:update', async (ev) => { const r = await calendar.updateEvent(ev); notifier.invalidate(); return r; });
handle('cal:delete', (ev) => calendar.deleteEvent(ev));

// --- Delete with Undo ---
// Deleting from the UI waits UNDO_MS before actually deleting from Google, so "Undo"
// just cancels the timer and the event comes back exactly as it was (guests, Meet link…).
// The wait lives here in the backend so refreshes don't resurrect it and quitting
// the app still finishes the delete (see the before-quit handler at the top).
const UNDO_MS = 6000;
// Assistant deletes: longer, since you first have to read the reply to notice one.
const ASSISTANT_UNDO_MS = 20000;
// The same queue handles Google Tasks: entries are { kind: 'event', calendarId, eventId }
// or { kind: 'task', listId, taskId }.
const pendingDeletes = new Map(); // token → { kind, …ids, timer }
let nextToken = 1;

const pendingDeleteKeys = () =>
  new Set([...pendingDeletes.values()].filter((p) => p.kind === 'event').map((p) => `${p.calendarId}|${p.eventId}`));
const pendingTaskKeys = () =>
  new Set([...pendingDeletes.values()].filter((p) => p.kind === 'task').map((p) => `${p.listId}|${p.taskId}`));

const inFlightDeletes = new Set(); // deletes sent to Google and not answered yet (quit waits for them)

async function runDelete(token) {
  const p = pendingDeletes.get(token);
  if (!p) return;
  clearTimeout(p.timer);
  pendingDeletes.delete(token);
  const job = (async () => {
    try {
      await (p.kind === 'task' ? tasks.deleteTask(p) : calendar.deleteEvent(p));
    } catch (err) {
      // Already gone is fine; anything else: the item comes back, so say why.
      const status = err?.response?.status || err?.code;
      if (status !== 404 && status !== 410) {
        console.error('[delete]', err.message);
        win()?.webContents.send('delete:failed', { title: p.title || '', isTask: p.kind === 'task', error: err.message });
      }
    }
  })();
  inFlightDeletes.add(job);
  try { await job; } finally { inFlightDeletes.delete(job); }
  notifyChanged();
}

/**
 * Hide an event ({ calendarId, eventId }) or a task ({ kind: 'task', listId, taskId }) and
 * queue its deletion. The countdown starts now, or later via startDeleteTimer().
 */
function queueDelete(item, startNow = true) {
  const token = nextToken++;
  if (!item || typeof item !== 'object') throw new Error('Nothing to delete.');
  const title = typeof item.title === 'string' ? item.title.slice(0, 200) : '';
  pendingDeletes.set(token, item.kind === 'task'
    ? { kind: 'task', listId: String(item.listId), taskId: String(item.taskId), title, timer: null }
    : { kind: 'event', calendarId: String(item.calendarId), eventId: String(item.eventId), title, timer: null });
  if (startNow) startDeleteTimer(token);
  return token;
}
function startDeleteTimer(token, ms = UNDO_MS) {
  const p = pendingDeletes.get(token);
  if (p && !p.timer) p.timer = setTimeout(() => runDelete(token), ms);
}
function cancelDelete(token) {
  const p = pendingDeletes.get(token);
  if (!p) return false; // too late: already deleted
  clearTimeout(p.timer);
  pendingDeletes.delete(token);
  return true;
}

handle('cal:deleteLater', (ev) => queueDelete(ev));
handle('cal:undoDelete', (token) => cancelDelete(token));
// On quit, finish deletes whose Undo window is running, and wait for ones already sent.
// (A delete queued by the assistant whose reply never arrived has no timer yet; it's
// dropped and the event stays.)
const flushDeletes = () => Promise.all([
  ...[...pendingDeletes.entries()].filter(([, p]) => p.timer).map(([token]) => runDelete(token)),
  ...inFlightDeletes,
]);

// --- Google Tasks ---
// Tasks need the extra "tasks" permission; sign-ins from before it existed get
// a "Connect Google Tasks" button, which simply signs in again (Google keeps the rest).
handle('tasks:status', () => ({ connected: auth.hasTasksScope() }));
handle('tasks:connect', () => auth.signIn());
handle('tasks:lists', () => tasks.listTaskLists({ fresh: true }));
handle('tasks:setListVisible', (id, visible) => tasks.setListVisible(id, visible));
/** { fromISO, toISO, includeOverdue, includeUndated, includeCompleted } */
handle('tasks:list', async (q = {}) => {
  const list = await tasks.listTasks({
    ...q,
    from: q.fromISO ? new Date(q.fromISO) : undefined,
    to: q.toISO ? new Date(q.toISO) : undefined,
  });
  return list.filter((t) => !pendingTaskKeys().has(`${t.listId}|${t.id}`));
});
handle('tasks:create', (t) => tasks.createTask(t));
handle('tasks:update', (t) => tasks.updateTask(t));
handle('tasks:deleteLater', ({ listId, taskId, title } = {}) => queueDelete({ kind: 'task', listId, taskId, title }));
handle('tasks:parse', (text) => parseTask(text));

/** "call mom friday" → { title: 'call mom', due: '2026-11-27' }. No date → today. */
function parseTask(text) {
  const p = quickadd.parse(String(text || ''), new Date(), prefs.get('defaultEventMinutes'));
  if (!p || !p.title) return { title: String(text || '').trim(), due: tasks.ymd(new Date()), dateFound: false };
  // All-day results are already 'YYYY-MM-DD' (new Date() would read them as UTC, a day early here).
  return { title: p.title, due: p.allDay ? p.start : tasks.ymd(new Date(p.start)), dateFound: true };
}

// --- quick add ---
handle('quick:parse', (text) => parseQuick(text));
handle('quick:add', async (text) => {
  const parsed = await parseQuick(text);
  if (!parsed) throw new Error("Couldn't find a date/time in that. Try e.g. \"gym tomorrow 6pm\".");
  const created = await calendar.createEvent(parsed);
  notifier.invalidate();
  // Tell the page where the new event is, so it can jump there and highlight it.
  return { ...created, calendarName: parsed.calendarName };
});

/**
 * Parse quick-add text and pick its calendar: a "#tag" is matched against the names
 * of calendars you can write to (exact name, then starts-with, then contains,
 * ignoring case). No tag, or no match → your primary calendar.
 */
async function parseQuick(text) {
  const parsed = quickadd.parse(text, new Date(), prefs.get('defaultEventMinutes'));
  if (!parsed) return null;
  const writable = (await calendar.listCalendars()).filter((c) => c.canEdit);
  // "Default calendar for new events" from Settings, else your primary calendar.
  const primary = writable.find((c) => c.id === prefs.get('defaultCalendarId'))
    || writable.find((c) => c.primary) || writable[0];
  let cal = primary;
  let tagUnmatched = false;
  if (parsed.calendarTag) {
    const tag = parsed.calendarTag.toLowerCase();
    const name = (c) => c.name.toLowerCase();
    cal = writable.find((c) => name(c) === tag)
      || writable.find((c) => name(c).startsWith(tag))
      || writable.find((c) => name(c).includes(tag));
    if (!cal) { cal = primary; tagUnmatched = true; }
  }
  return { ...parsed, calendarId: cal?.id || 'primary', calendarName: cal?.name || '', tagUnmatched };
}

// --- chatbot ---
// Assistant deletes don't ask first: the event is hidden right away, and the Undo
// window (UNDO_MS) starts once the reply is on screen, so you have time to see it.
handle('chat:send', async (text) => {
  const queued = [];
  if (typeof text !== 'string' || !text.trim()) throw new Error('Type a message first.');
  if (text.length > 4000) throw new Error('That message is too long (4,000 characters at most).');
  const queue = (ev) => { const t = queueDelete(ev, false); queued.push(t); return t; };
  let result;
  try {
    result = await assistant.send(text, { onChanged: notifyChanged, queueDelete: queue });
  } catch (err) {
    queued.forEach(cancelDelete); // the turn failed: don't delete anything behind your back
    notifyChanged();
    throw err;
  }
  // Deletes get their Undo countdown only once the reply (with its Undo button) is shown;
  // anything queued but not reported is cancelled.
  for (const a of result.actions) if (a.kind === 'deleted' && pendingDeletes.has(a.token)) pendingDeletes.get(a.token).title = a.title || '';
  const reported = new Set(result.actions.filter((a) => a.kind === 'deleted').map((a) => a.token));
  for (const t of queued) { if (reported.has(t)) startDeleteTimer(t, ASSISTANT_UNDO_MS); else cancelDelete(t); }
  if (queued.some((t) => !reported.has(t))) notifyChanged();
  return { ...result, undoMs: ASSISTANT_UNDO_MS };
});
handle('chat:reset', () => assistant.reset());
handle('chat:keyStatus', () => assistant.hasKey());
handle('chat:setKey', (key) => assistant.setKey(key));
handle('chat:settings', () => assistant.getSettings());
handle('chat:setSettings', (changes) => assistant.setSettings(changes));
handle('chat:fetchModels', () => assistant.fetchModels());

// --- window controls (minimize/maximize/close are drawn by Windows itself) ---
handle('win:togglePin', () => {
  const pinned = !win().isAlwaysOnTop();
  win().setAlwaysOnTop(pinned);
  prefs.set({ alwaysOnTop: pinned });
  return pinned;
});
handle('win:isPinned', () => win().isAlwaysOnTop());
// Settings → Notifications → "Send a test notification"
handle('notify:test', () => notifier.show({
  id: 'test', calendarId: 'test', title: 'Test notification',
  start: new Date(Date.now() + prefs.get('notifyMinutes') * 60000).toISOString(),
  end: new Date(Date.now() + (prefs.get('notifyMinutes') + 60) * 60000).toISOString(),
  location: 'This is what reminders will look like', meetLink: '',
}, prefs.get('notifyMinutes') * 60000));
handle('open:url', (url) => { if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url); });

// --- preferences (Settings) ---
handle('prefs:get', () => ({
  prefs: prefs.all(),
  hotkeyLabel: background.pretty(prefs.get('hotkey')),
  hotkeyStatus,
  isPackaged: app.isPackaged, // start-with-Windows only applies to the installed app
}));

/**
 * Apply changes from Settings. Side effects (hotkey, login item) happen before saving.
 * Only the settings that page edits, with valid values (prefcheck.js): addresses that receive
 * your Google token or API keys have their own checked channels (sync:setUrl, chat:setSettings).
 */
handle('prefs:set', (changes) => {
  checkSettingsPage(changes);
  if (changes.hotkey !== undefined && changes.hotkey !== prefs.get('hotkey')) {
    const result = background.setHotkey(changes.hotkey);
    if (!result.ok) throw new Error(result.error); // old hotkey stays active and saved
    hotkeyStatus = result;
  }
  if (changes.startWithWindows !== undefined) background.applyStartWithWindows(changes.startWithWindows);
  const saved = prefs.set(changes);
  if ('notifyEnabled' in changes || 'notifyMinutes' in changes) notifier.invalidate();
  return saved;
});
