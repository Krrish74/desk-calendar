// sync.js: the Windows app shares its settings with the phone through this Worker.
//
// The phone already keeps its settings here (prefs.js). The desktop app reads them when
// it starts, every few minutes and when its window comes forward, and saves here whenever
// you change one of the SHARED settings below. So there's one copy, and both apps follow it.
//
// HOW THE PC PROVES WHO IT IS (no codes, no extra sign-in)
// The desktop app is already signed in to Google (its own "Desktop app" OAuth client, in
// the same Google Cloud project). It sends its current Google access token, and we ask
// Google about it:
//   1. tokeninfo: is it valid, and was it issued to a client in OUR Cloud project? (Client
//      ids start with the project number, so the Web client's id tells us which one.)
//   2. Calendar API "primary" calendar: its id is the account's email address. That email
//      must be on the allow-list, same as for the phone.
// A verified token is remembered (by its hash) until it expires, so this costs two
// Google calls per hour at most.

import { isAllowed, isLocalDev } from './auth.js';
import { sha256 } from './crypto.js';
import { HttpError, badRequest, notSignedIn } from './http.js';
import { setPrefs } from './prefs.js';

/** Settings both apps share. Everything else (reminders on/off, view, model…) stays per device. */
export const SHARED_KEYS = [
  'calendarVisibility', 'taskListVisibility', 'defaultCalendarId', 'defaultTaskListId',
  'defaultEventMinutes', 'timeFormat', 'weekStartsOn', 'notifyMinutes', 'userProfile',
];

const verified = new Map(); // sha256(token) → { email, expires }

/** The email behind a desktop app's Google access token, or a 401/403. */
export async function desktopEmail(env, token, url) {
  if (!token) throw notSignedIn('Missing Google token.');
  // Local testing with the fake calendar: a fixed token stands in for Google's.
  if (env.MOCK_GOOGLE === '1' && isLocalDev(url) && token === 'mock-desktop') {
    return String(env.ALLOWED_EMAILS || '').split(',')[0].trim().toLowerCase();
  }
  const key = await sha256(token);
  const hit = verified.get(key);
  if (hit && hit.expires > Date.now()) return hit.email;

  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!info || !info.aud) throw notSignedIn('Google didn\'t accept the desktop app\'s sign-in. Sign in again in the desktop app.');
  const project = String(env.GOOGLE_CLIENT_ID || '').split('-')[0];
  if (!project || !String(info.aud).startsWith(`${project}-`)) {
    throw new HttpError(403, 'That Google sign-in belongs to a different Google Cloud project than this Desk Calendar.', 'WRONG_PROJECT');
  }
  if (!String(info.scope || '').includes('https://www.googleapis.com/auth/calendar')) throw new HttpError(403, 'The desktop sign-in has no calendar permission.', 'FORBIDDEN');

  const cal = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const email = String(cal?.id || '').toLowerCase();
  if (!email || !isAllowed(env, email)) throw new HttpError(403, 'This Google account isn\'t allowed to use this Desk Calendar.', 'FORBIDDEN');
  verified.set(key, { email, expires: Date.now() + Math.min(Number(info.expires_in) || 300, 3600) * 1000 });
  if (verified.size > 50) verified.delete(verified.keys().next().value);
  return email;
}

/**
 * GET /api/sync → { values, setOnServer }
 *   values       the shared settings as they are now
 *   setOnServer  which of them were ever changed here (on the phone or by a PC). On the
 *                very first link the PC keeps its own value for the others and sends it.
 */
export async function getShared(c) {
  const row = await c.env.DB.prepare('SELECT json FROM prefs WHERE email = ?').bind(c.email).first();
  let raw = {};
  try { raw = row ? JSON.parse(row.json) : {}; } catch { /* treat as empty */ }
  return {
    values: Object.fromEntries(SHARED_KEYS.map((k) => [k, c.prefs[k]])),
    setOnServer: SHARED_KEYS.filter((k) => k in raw),
  };
}

/** PATCH /api/sync { key: value, … }: save shared settings (same checks as the phone's). */
export async function setShared(c, changes) {
  const bad = Object.keys(changes).filter((k) => !SHARED_KEYS.includes(k));
  if (bad.length) throw badRequest(`Not a shared setting: ${bad.join(', ')}.`);
  if (!Object.keys(changes).length) return getShared(c);
  c.prefs = await setPrefs(c.env.DB, c.email, changes);
  return getShared(c);
}
