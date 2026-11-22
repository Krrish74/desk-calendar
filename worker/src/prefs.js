// prefs.js: your phone-app settings, stored as one JSON row per account in D1.
//
// Ported from src/main/prefs.js. Desktop-only settings (hotkey, tray, always-on-top,
// start with Windows) are left out. The phone keeps its own copy of these values; they
// are separate from the desktop app's settings.
//
// To add a setting: add it to DEFAULTS with its default value and a check in VALIDATORS.
// Saved settings that predate it automatically get the default.

import { MODELS, DEFAULT_MODEL } from './models.js';
import { safeTimeZone } from './tz.js';
import { badRequest } from './http.js';
import { normalizeProfile } from './freetime.js';

export const DEFAULTS = {
  calendarVisibility: {},          // { calendarId: true/false }; unset = Google Calendar's own tick
  view: 'agenda',                  // last-used view: agenda | day | 3day | month
  weekStartsOn: 0,                 // 0 = Sunday, 1 = Monday
  agendaDays: 14,                  // Agenda loads today + the next (agendaDays - 1) days at a time
  timeFormat: 'system',            // 'system' (the iPhone's setting) | '12' | '24'
  defaultEventMinutes: 60,         // length of new events (quick add, tap-to-create, editor)
  defaultCalendarId: null,         // calendar for new events; null = your primary calendar
  notifyEnabled: true,             // push reminders before events (Phase 4)
  notifyMinutes: 10,               // ...this many minutes before (0 = at start time)
  assistantModel: DEFAULT_MODEL,   // Claude model for the assistant (see models.js)
  timeZone: 'UTC',                 // the phone's time zone, updated automatically (used by reminders)
  taskListVisibility: {},          // { taskListId: true/false } for Google Tasks lists; unset = shown
  defaultTaskListId: null,         // list for new tasks; null = your main list ("My Tasks")
  userProfile: null,               // "About you" for the assistant (Settings); see freetime.js PROFILE_DEFAULTS
  assistantUsage: null,            // { month: 'YYYY-MM', cost, messages, requests, tokens, last }: assistant spend
};

// What each setting may be. Anything else in a request is rejected, so a bad value
// can't end up stored and break the app later.
const isBool = (v) => typeof v === 'boolean';
const VALIDATORS = {
  calendarVisibility: (v) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length <= 200 && Object.values(v).every(isBool),
  view: (v) => ['agenda', 'day', '3day', 'month'].includes(v),
  weekStartsOn: (v) => v === 0 || v === 1,
  agendaDays: (v) => Number.isInteger(v) && v >= 1 && v <= 60,
  timeFormat: (v) => ['system', '12', '24'].includes(v),
  defaultEventMinutes: (v) => Number.isInteger(v) && v >= 5 && v <= 24 * 60,
  defaultCalendarId: (v) => v === null || (typeof v === 'string' && v.length <= 300),
  taskListVisibility: (v) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length <= 100 && Object.values(v).every(isBool),
  defaultTaskListId: (v) => v === null || (typeof v === 'string' && v.length <= 300),
  userProfile: (v) => v && typeof v === 'object' && !Array.isArray(v), // cleaned up by normalizeProfile below
  notifyEnabled: isBool,
  notifyMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 24 * 60,
  assistantModel: (v) => typeof v === 'string' && v in MODELS,
  timeZone: (v) => typeof v === 'string' && safeTimeZone(v) === v,
};

export async function getPrefs(db, email) {
  const row = await db.prepare('SELECT json FROM prefs WHERE email = ?').bind(email).first();
  let saved = {};
  try { saved = row ? JSON.parse(row.json) : {}; } catch { /* corrupt row: fall back to defaults */ }
  return { ...DEFAULTS, ...saved };
}

/**
 * Merge `changes` into the saved settings. Throws 400 on an unknown key or bad value.
 *
 * The merge happens inside the database (SQLite's json_patch), in one statement, so
 * two changes sent at the same moment (say, the time format and the model) can't
 * overwrite each other. Nested objects merge too: { calendarVisibility: { id: true } }
 * changes just that calendar. A null value removes the key (= back to its default).
 */
export async function setPrefs(db, email, changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in VALIDATORS)) throw badRequest(`Unknown setting "${key}".`);
    if (!VALIDATORS[key](value)) throw badRequest(`Invalid value for "${key}".`);
  }
  // The profile is stored whole and cleaned up (defaults filled in, junk dropped).
  if (changes.userProfile) changes = { ...changes, userProfile: normalizeProfile(changes.userProfile) };
  return patchPrefs(db, email, changes);
}

/**
 * Merge changes the Worker itself makes (no checks: callers pass well-formed values),
 * e.g. the assistant's running cost total, which the phone can't set.
 */
export async function patchPrefs(db, email, changes) {
  const row = await db.prepare(`INSERT INTO prefs (email, json) VALUES (?1, json_patch('{}', ?2))
      ON CONFLICT(email) DO UPDATE SET json = json_patch(prefs.json, ?2)
      RETURNING json`)
    .bind(email, JSON.stringify(changes)).first();
  return { ...DEFAULTS, ...JSON.parse(row.json) };
}
