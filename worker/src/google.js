// google.js: authenticated calls to the Google Calendar REST API.
//
// The desktop app used the `@googleapis/calendar` library; that library needs Node.js,
// so here we call the same REST endpoints with plain fetch().
//   REST reference: https://developers.google.com/calendar/api/v3/reference
//
// ACCESS TOKENS
// Every call needs a 1-hour access token. We keep the current one (encrypted) in D1
// and in memory, and when it's about to expire we use the refresh token to get a new
// one. If Google says the refresh token is dead ("invalid_grant": you revoked access,
// or the 7-day expiry of apps in Testing mode), we forget it and the phone shows
// "Sign in" again, just like the desktop app.

import { HttpError, notSignedIn } from './http.js';
import { encrypt, decrypt } from './crypto.js';
import { forgetAccount } from './auth.js';
import { mockGoogle } from './mock-google.js';

const API = 'https://www.googleapis.com/calendar/v3';

/** An error from Google with its HTTP status (404 = no such event, 403 = no permission, …). */
export class GoogleError extends HttpError {
  constructor(status, message) {
    // Pass Google's message through, but never claim a 401 (that means "you're signed out" to the phone).
    super(status === 401 ? 502 : status, message, 'GOOGLE');
    this.googleStatus = status;
  }
}

const memoryTokens = new Map(); // email → { token, expires }  (lives as long as this Worker instance)
const refreshing = new Map();   // email → Promise, so parallel calls share one refresh

async function accessToken(env, email, { force = false } = {}) {
  const cached = memoryTokens.get(email);
  if (!force && cached && cached.expires - 60_000 > Date.now()) return cached.token;

  const row = await env.DB.prepare('SELECT refresh_token, access_token, access_expires FROM accounts WHERE email = ?').bind(email).first();
  if (!row) throw notSignedIn('Please sign in with Google.');
  if (!force && row.access_token && row.access_expires - 60_000 > Date.now()) {
    const token = await decrypt(env.TOKEN_KEY, row.access_token);
    memoryTokens.set(email, { token, expires: row.access_expires });
    return token;
  }

  if (!refreshing.has(email)) {
    refreshing.set(email, refresh(env, email, row.refresh_token).finally(() => refreshing.delete(email)));
  }
  return refreshing.get(email);
}

async function refresh(env, email, encryptedRefresh) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await decrypt(env.TOKEN_KEY, encryptedRefresh),
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant' || data.error === 'invalid_rapt') {
      memoryTokens.delete(email);
      await forgetAccount(env, email);
      throw notSignedIn('Your Google sign-in expired. Please sign in again.');
    }
    throw new HttpError(502, `Google sign-in refresh failed (${data.error || res.status}).`);
  }
  const expires = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  // Google reports the granted permissions on refresh too; keep them current (tasks.js
  // checks them to offer "Connect Google Tasks" to sign-ins from before Tasks existed).
  await env.DB.prepare('UPDATE accounts SET access_token = ?, access_expires = ?, scope = COALESCE(?, scope), updated_at = ? WHERE email = ?')
    .bind(await encrypt(env.TOKEN_KEY, data.access_token), expires, data.scope || null, Date.now(), email).run();
  memoryTokens.set(email, { token: data.access_token, expires });
  return data.access_token;
}

/** Google Tasks REST API (tasks.js passes full URLs starting with this). */
export const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

/**
 * Call a Google API as `email`.
 *   path   Calendar: e.g. '/users/me/calendarList' or `/calendars/${id}/events`;
 *          any other Google API: a full URL (tasks.js uses `${TASKS_API}/…`)
 *   query  URL parameters (undefined values are skipped)
 *   body   JSON request body for POST / PATCH
 * Returns the parsed JSON (or null for an empty answer, e.g. after DELETE).
 */
export async function google({ env, email }, path, { method = 'GET', query, body } = {}) {
  if (env.MOCK_GOOGLE === '1') {
    try {
      return await mockGoogle(email, path, { method, query, body });
    } catch (err) {
      if (err.googleStatus) throw new GoogleError(err.googleStatus, err.message);
      throw err;
    }
  }

  const url = new URL(path.startsWith('https://') ? path : API + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  const send = async (token) => fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let res = await send(await accessToken(env, email));
  if (res.status === 401) res = await send(await accessToken(env, email, { force: true })); // token revoked early: refresh once
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new GoogleError(res.status, data?.error?.message || `Google error ${res.status}.`);
  return data;
}

/** Calendar ids contain @ and #, so they must be escaped inside URL paths. */
export const enc = encodeURIComponent;
