// Tests for the desktop ↔ phone settings sync (src/sync.js): how the Windows app's Google
// token is checked, and which settings are shared. Google is stubbed. Run: npm test.

process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sync = await import('../src/sync.js');
const { getPrefs, setPrefs } = await import('../src/prefs.js');

function d1() {
  const db = new DatabaseSync(':memory:');
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(dir + f, 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

const EMAIL = 'owner@example.com';
const env = { DB: d1(), GOOGLE_CLIENT_ID: '123456789012-web.apps.googleusercontent.com', ALLOWED_EMAILS: EMAIL };
const url = new URL('https://desk-calendar.example.workers.dev/api/sync');

// Stubbed Google: tokens → { aud, scope, email }
const tokens = {
  good: { aud: '123456789012-desktop.apps.googleusercontent.com', email: EMAIL },
  otherProject: { aud: '999999999999-x.apps.googleusercontent.com', email: EMAIL },
  stranger: { aud: '123456789012-desktop.apps.googleusercontent.com', email: 'someone@else.com' },
};
let calls = 0;
globalThis.fetch = async (u, init) => {
  calls++;
  u = String(u);
  if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
    // The token must come in the POST body, never in the URL (where logs could keep it).
    assert.equal(new URL(u).search, '', 'no token in the URL');
    assert.equal(init?.method, 'POST');
    const t = tokens[new URLSearchParams(String(init.body)).get('access_token')];
    return t ? new Response(JSON.stringify({ aud: t.aud, azp: t.aud, scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks', expires_in: 3000 }))
      : new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 });
  }
  if (u === 'https://www.googleapis.com/calendar/v3/calendars/primary') {
    const t = tokens[init.headers.Authorization.slice(7)];
    return new Response(JSON.stringify({ id: t.email }));
  }
  throw new Error(`unexpected fetch ${u}`);
};

test('a desktop token from our Cloud project and the allowed account is accepted (and remembered)', async () => {
  calls = 0;
  assert.equal(await sync.desktopEmail(env, 'good', url), EMAIL);
  assert.equal(calls, 2, 'tokeninfo + primary calendar');
  assert.equal(await sync.desktopEmail(env, 'good', url), EMAIL);
  assert.equal(calls, 2, 'second time: no Google calls');
});

test('tokens from another project, another account, or not valid are refused', async () => {
  await assert.rejects(sync.desktopEmail(env, 'otherProject', url), (e) => e.status === 403 && e.code === 'WRONG_PROJECT');
  await assert.rejects(sync.desktopEmail(env, 'stranger', url), (e) => e.status === 403);
  await assert.rejects(sync.desktopEmail(env, 'expired', url), (e) => e.status === 401);
  await assert.rejects(sync.desktopEmail(env, '', url), (e) => e.status === 401);
});

test('the fixed local-testing token only works with the fake calendar on localhost', async () => {
  const local = new URL('http://localhost:8787/api/sync');
  assert.equal(await sync.desktopEmail({ ...env, MOCK_GOOGLE: '1' }, 'mock-desktop', local), EMAIL);
  await assert.rejects(sync.desktopEmail({ ...env, MOCK_GOOGLE: '1' }, 'mock-desktop', url)); // deployed address
  await assert.rejects(sync.desktopEmail(env, 'mock-desktop', local)); // mock mode off
});

test('shared settings: what was set on the server, saving, and refusing per-device ones', async () => {
  const ctx = async () => ({ env, email: EMAIL, prefs: await getPrefs(env.DB, EMAIL) });
  let s = await sync.getShared(await ctx());
  assert.deepEqual(s.setOnServer, [], 'nothing set yet: on first link the PC keeps its own values');
  assert.deepEqual(Object.keys(s.values), sync.SHARED_KEYS);
  await setPrefs(env.DB, EMAIL, { timeFormat: '24', view: 'month', notifyEnabled: false }); // as if changed on the phone
  s = await sync.getShared(await ctx());
  assert.deepEqual(s.setOnServer, ['timeFormat'], 'only shared keys are reported');
  s = await sync.setShared(await ctx(), { weekStartsOn: 1, userProfile: { dayStart: '08:00' }, calendarVisibility: { 'a@group': false } });
  assert.equal(s.values.weekStartsOn, 1);
  assert.equal(s.values.userProfile.dayStart, '08:00');
  assert.equal(s.values.userProfile.dayEnd, '17:00', 'profile filled in with defaults');
  assert.deepEqual(s.values.calendarVisibility, { 'a@group': false });
  await assert.rejects(sync.setShared(await ctx(), { notifyEnabled: true }), /Not a shared setting/);
  await assert.rejects(sync.setShared(await ctx(), { timeFormat: '13' }), /Invalid value/);
});
