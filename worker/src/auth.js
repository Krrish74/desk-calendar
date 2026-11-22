// auth.js: Google sign-in, the session cookie, and the allow-list.
//
// THE FLOW (OAuth 2.0 "authorization code" flow for a Web application client)
//  1. The phone opens /auth/login. We make a random `state` and a PKCE "verifier",
//     keep both in a short-lived cookie, and redirect to Google's sign-in page.
//  2. You sign in and approve. Google redirects to /auth/callback?code=…&state=….
//  3. We check `state` matches the cookie (so the callback really came from a sign-in
//     YOU started), then trade the code + verifier + client secret for tokens:
//       - access_token:  1 hour, sent with every Calendar API call
//       - refresh_token: long-lived, used to get new access tokens without asking you
//       - id_token:      says which Google account signed in (email)
//  4. ALLOW-LIST: if that email isn't in the ALLOWED_EMAILS secret, we stop here and
//     store nothing. Anyone can reach the sign-in page, but only your account gets in.
//  5. We store the tokens encrypted in D1 and give the phone a session cookie.
//
// THE SESSION COOKIE
//  • A random 256-bit id. D1 stores only its SHA-256 hash.
//  • HttpOnly (page scripts can't read it), Secure, SameSite=Lax, "__Host-" prefix.
//  • Lasts 180 days and renews itself as you use the app, so you stay signed in.
//
// The Desktop app (src/main/auth.js) used a loopback redirect to 127.0.0.1; a phone
// can't do that, which is why this uses a separate "Web application" OAuth client
// whose redirect URI points at this Worker.

import { HttpError, notSignedIn, htmlPage, getCookie, setCookie, cookieName } from './http.js';
import { randomId, sha256, safeEqual, b64urlDecode, encrypt, decrypt } from './crypto.js';

export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const SCOPES = [
  'openid',
  'email',                                              // which account signed in (for the allow-list)
  'https://www.googleapis.com/auth/calendar.readonly',  // calendar list, colors, events
  'https://www.googleapis.com/auth/calendar.events',    // create / edit / delete events
  TASKS_SCOPE,                                          // Google Tasks: read, add, complete, delete
];
// The calendar permissions are required; without Tasks the app still works and offers
// "Connect Google Tasks" (which simply runs this sign-in again).
const REQUIRED_SCOPES = SCOPES.filter((s) => s.includes('/auth/calendar'));

const SESSION_DAYS = 180;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // extend the session at most once a day
const OAUTH_COOKIE_SECONDS = 10 * 60;        // you have 10 minutes to finish signing in

const isHttps = (url) => url.protocol === 'https:';
const sessionCookie = (url) => cookieName('dc_session', isHttps(url));
const oauthCookie = (url) => cookieName('dc_oauth', isHttps(url));

/** The allow-list: ALLOWED_EMAILS is a comma-separated list. Empty = nobody (fail closed). */
export function isAllowed(env, email) {
  const allowed = String(env.ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !!email && allowed.includes(String(email).toLowerCase());
}

/** Mock mode (fake calendar for local testing) must never run anywhere but localhost. */
export function isLocalDev(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

// ---------------------------------------------------------------------------
// Step 1: /auth/login → Google
// ---------------------------------------------------------------------------

export async function login(request, env) {
  const url = new URL(request.url);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return htmlPage('Not set up yet', 'The Google client ID and secret haven\'t been added to the Worker. See SETUP-IPHONE.md.', { status: 500 });
  }
  const state = randomId();
  const verifier = randomId(48);
  const challenge = await sha256(verifier); // PKCE S256: base64url(SHA-256(verifier))

  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',   // we want a refresh token…
    prompt: 'consent',        // …and Google only sends one when the consent screen is shown
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      Location: google.toString(),
      'Set-Cookie': setCookie(oauthCookie(url), `${state}.${verifier}`, { maxAge: OAUTH_COOKIE_SECONDS, secure: isHttps(url) }),
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// Steps 2–5: /auth/callback
// ---------------------------------------------------------------------------

export async function callback(request, env) {
  const url = new URL(request.url);
  const retry = { href: '/auth/login', text: 'Try again' };
  const clearOauth = setCookie(oauthCookie(url), '', { maxAge: 0, secure: isHttps(url) });
  const fail = (title, message, status = 400) => {
    const res = htmlPage(title, message, { status, link: retry });
    res.headers.append('Set-Cookie', clearOauth);
    return res;
  };

  if (url.searchParams.get('error')) {
    return fail('Sign-in cancelled', 'Google didn\'t complete the sign-in. You can try again.');
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const [savedState, verifier] = (getCookie(request, oauthCookie(url)) || '').split('.');
  if (!code || !state || !savedState || !verifier || !safeEqual(state, savedState)) {
    return fail('Sign-in expired', 'That sign-in link is no longer valid. Please start again from the app.');
  }

  // Trade the one-time code for tokens.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    console.error('[auth] token exchange failed:', tokens.error, tokens.error_description);
    return fail('Sign-in failed', 'Google rejected the sign-in. Check the OAuth client settings in SETUP-IPHONE.md and try again.', 502);
  }

  // Who signed in? The id_token came straight from Google over HTTPS in the response
  // above, so (per OpenID Connect) we can read it without re-checking its signature.
  // We still check it's meant for our client and not expired.
  const claims = readIdToken(tokens.id_token);
  if (!claims || claims.aud !== env.GOOGLE_CLIENT_ID
      || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)
      || claims.exp * 1000 < Date.now()) {
    return fail('Sign-in failed', 'Google\'s answer didn\'t include a valid account. Please try again.', 502);
  }
  const email = String(claims.email || '').toLowerCase();
  if (!claims.email_verified || !isAllowed(env, email)) {
    console.warn('[auth] blocked sign-in by an account not on the allow-list');
    return fail('Not allowed', 'This Desk Calendar only lets its owner\'s Google account sign in. Try again with your own account.', 403);
  }

  // Google lets you untick permissions on the consent screen. Both calendar ones are needed.
  const granted = String(tokens.scope || '').split(' ');
  const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) {
    return fail('Permission needed', 'Please tick both calendar permissions on Google\'s screen so Desk Calendar can show and edit your events.');
  }

  await saveAccount(env, email, tokens);

  const res = await startSession(request, env, email);
  res.headers.append('Set-Cookie', clearOauth);
  return res;
}

function readIdToken(idToken) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(String(idToken).split('.')[1])));
  } catch {
    return null;
  }
}

/** Store (or update) the encrypted tokens. Google may omit refresh_token on re-consent: keep the old one. */
async function saveAccount(env, email, tokens) {
  const now = Date.now();
  const access = await encrypt(env.TOKEN_KEY, tokens.access_token);
  const expires = now + (Number(tokens.expires_in) || 3600) * 1000;
  if (tokens.refresh_token) {
    const refresh = await encrypt(env.TOKEN_KEY, tokens.refresh_token);
    await env.DB.prepare(`INSERT INTO accounts (email, refresh_token, access_token, access_expires, scope, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      ON CONFLICT(email) DO UPDATE SET refresh_token = ?2, access_token = ?3, access_expires = ?4, scope = ?5, updated_at = ?6`)
      .bind(email, refresh, access, expires, tokens.scope || '', now).run();
  } else {
    const { meta } = await env.DB.prepare('UPDATE accounts SET access_token = ?, access_expires = ?, scope = ?, updated_at = ? WHERE email = ?')
      .bind(access, expires, tokens.scope || '', now, email).run();
    if (!meta.changes) throw new HttpError(502, 'Google didn\'t send a refresh token. Remove Desk Calendar at myaccount.google.com/permissions and sign in again.');
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Create a session and redirect into the app with its cookie. */
export async function startSession(request, env, email) {
  const url = new URL(request.url);
  const id = randomId();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (id_hash, email, created_at, last_seen, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(id), email, now, now, now + SESSION_MS, (request.headers.get('User-Agent') || '').slice(0, 200)).run();
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/',
      'Set-Cookie': setCookie(sessionCookie(url), id, { maxAge: SESSION_MS / 1000, secure: isHttps(url) }),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Who is calling? Returns { email, renewCookie? } or throws 401.
 * renewCookie is a fresh Set-Cookie header when the session was just extended.
 */
export async function requireSession(request, env) {
  const url = new URL(request.url);
  const id = getCookie(request, sessionCookie(url));
  if (!id) throw notSignedIn();
  const idHash = await sha256(id);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT email, last_seen, expires_at FROM sessions WHERE id_hash = ?').bind(idHash).first();
  if (!row || row.expires_at < now) throw notSignedIn();
  // The allow-list is checked on every request, so removing an email locks it out at once.
  if (!isAllowed(env, row.email)) throw notSignedIn('This account is no longer allowed.');

  let renewCookie;
  if (now - row.last_seen > RENEW_AFTER_MS) {
    await env.DB.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?').bind(now, now + SESSION_MS, idHash).run();
    renewCookie = setCookie(sessionCookie(url), id, { maxAge: SESSION_MS / 1000, secure: isHttps(url) });
  }
  return { email: row.email, renewCookie };
}

/**
 * POST /auth/logout: sign this phone out.
 * With { everywhere: true }: also revoke Desk Calendar's access at Google and delete the
 * stored tokens, every session and the assistant conversation (your settings stay).
 */
export async function logout(request, env, { everywhere = false } = {}) {
  const url = new URL(request.url);
  const id = getCookie(request, sessionCookie(url));
  if (id) {
    const idHash = await sha256(id);
    const row = await env.DB.prepare('SELECT email FROM sessions WHERE id_hash = ?').bind(idHash).first();
    await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
    if (everywhere && row) await forgetAccount(env, row.email, { revoke: true });
  }
  return new Response(JSON.stringify({ signedOut: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': setCookie(sessionCookie(url), '', { maxAge: 0, secure: isHttps(url) }),
    },
  });
}

/**
 * Remove an account's tokens and sessions. Used by "sign out everywhere", and when
 * Google says the refresh token is dead (revoked, or the 7-day Testing-mode expiry).
 */
export async function forgetAccount(env, email, { revoke = false } = {}) {
  if (revoke) {
    const row = await env.DB.prepare('SELECT refresh_token FROM accounts WHERE email = ?').bind(email).first();
    if (row) {
      try {
        const token = await decrypt(env.TOKEN_KEY, row.refresh_token);
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }),
        });
      } catch (err) {
        console.warn('[auth] revoke failed:', err.message);
      }
    }
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM accounts WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM chats WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM pending_deletes WHERE email = ?').bind(email),
    // Signing out everywhere also turns reminders off on every device. (An expired
    // sign-in keeps them, so reminders resume as soon as you sign in again.)
    ...(revoke ? [
      env.DB.prepare('DELETE FROM push_subscriptions WHERE email = ?').bind(email),
      env.DB.prepare('DELETE FROM push_sent WHERE email = ?').bind(email),
    ] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Local testing only: /auth/dev-login
// ---------------------------------------------------------------------------

/**
 * Skips Google entirely and signs in as the first allowed email, against the FAKE
 * calendar in mock-google.js. Only works when MOCK_GOOGLE=1 AND the request is to
 * localhost, so it can't be used on the deployed Worker.
 */
export async function devLogin(request, env) {
  const url = new URL(request.url);
  if (env.MOCK_GOOGLE !== '1' || !isLocalDev(url)) throw new HttpError(404, 'Not found.');
  const email = String(env.ALLOWED_EMAILS || '').split(',')[0].trim().toLowerCase();
  if (!email) throw new HttpError(500, 'Set ALLOWED_EMAILS in worker/.dev.vars first.');
  // ?tasks=0 pretends to be a sign-in from before Google Tasks was added (tests "Connect Google Tasks").
  const scopes = url.searchParams.get('tasks') === '0' ? SCOPES.filter((s) => s !== TASKS_SCOPE) : SCOPES;
  await saveAccount(env, email, { access_token: 'mock', refresh_token: 'mock', expires_in: 3600, scope: scopes.join(' ') });
  return startSession(request, env, email);
}
