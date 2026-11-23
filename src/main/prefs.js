// prefs.js: user preferences (non-secret), saved as plain JSON in the app-data folder.
//
// Secrets (Google token, AI API keys) do NOT go here; they're in secureStore.js.
// To add a preference: add it to DEFAULTS with its default value. Saved files that
// predate it automatically get the default.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  startWithWindows: true,                  // launch when you sign in to Windows / log in to the Mac
  startHidden: true,                       // ...and start in the tray / menu bar instead of opening the window
  hotkey: 'CommandOrControl+Shift+Space',  // global show/hide shortcut (Electron accelerator format)
  alwaysOnTop: false,                      // pin button state
  trayHintShown: false,                    // one-time "still running in the tray" notification
  calendarVisibility: {},                  // { calendarId: true/false } from "My calendars"; unset = Google's tick
  sidebarCollapsed: false,                 // ☰ button state (it also auto-collapses in narrow windows)
  view: 'week',                            // last-used view: day | week | month | agenda
  weekStartsOn: 0,                         // 0 = Sunday, 1 = Monday
  startView: 'last',                       // view on launch: 'last' (last used) | day | week | month | agenda
  agendaDays: 8,                           // Agenda shows today + the next (agendaDays - 1) days
  timeFormat: 'system',                    // 'system' (Windows / macOS setting) | '12' | '24'
  defaultEventMinutes: 60,                 // length of new events (quick add, click-to-create, editor)
  defaultCalendarId: null,                 // calendar for new events; null = your primary calendar
  notifyEnabled: true,                     // desktop notifications before events
  notifyMinutes: 10,                       // ...this many minutes before (0 = at start time)
  taskListVisibility: {},                  // { taskListId: true/false } for Google Tasks lists; unset = shown
  defaultTaskListId: null,                 // list for new tasks; null = your main list ("My Tasks")
  userProfile: null,                       // "About you" for the assistant (Settings → Assistant); see assistant.js PROFILE_DEFAULTS
  assistantUsage: null,                    // { month: 'YYYY-MM', cost, requests, last } running total of assistant spend
  assistantProvider: 'anthropic',          // which AI service answers (see providers.js)
  assistantModel: 'claude-haiku-5-5',      // Claude model, when the provider is Claude (see MODELS in assistant.js)
  assistantModels: {},                     // { providerId: model } for the other providers; unset = the provider's default
  assistantBaseUrls: {},                   // { providerId: url } server-address overrides; unset = the provider's default
  syncUrl: null,                           // the phone app's address (Settings → Account); shares some settings (sync.js)
  syncLinked: false,                       // first link with that address done
  syncDirty: [],                           // shared settings changed here and not sent yet
  syncLastAt: 0,                           // when settings were last synced with the phone app
};

const file = () => path.join(app.getPath('userData'), 'prefs.json');
let cache = null;

function all() {
  if (!cache) {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
    cache = { ...DEFAULTS, ...saved };
  }
  return cache;
}

const get = (key) => all()[key];

const listeners = [];
/** Call fn(changes) after every set() (sync.js uses it to send shared settings to the phone app). */
const onChange = (fn) => { listeners.push(fn); };

/**
 * Write a file so a crash or power cut mid-write can't leave it half-written (which would
 * silently reset every setting): write a temporary copy, then swap it in.
 */
function writeFileAtomic(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

function set(changes) {
  cache = { ...all(), ...changes };
  writeFileAtomic(file(), JSON.stringify(cache, null, 2));
  for (const fn of listeners) fn(changes);
  return cache;
}

module.exports = { all, get, set, onChange, DEFAULTS, writeFileAtomic };
