// Unit tests for src/main/sync.js (settings shared with the phone app).
// Uses a fake settings store and a fake phone-app server. Run: node --test test/unit
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSync, SHARED_KEYS, cleanUrl } = require('../../src/main/sync');

/** In-memory stand-in for src/main/prefs.js (with its onChange hook). */
function fakePrefs(initial) {
  let data = { syncUrl: 'https://desk.example.workers.dev', syncLinked: false, syncDirty: [], syncLastAt: 0, ...initial };
  const listeners = [];
  return {
    get: (k) => data[k],
    set: (c) => { data = { ...data, ...c }; for (const fn of listeners) fn(c); return data; },
    onChange: (fn) => listeners.push(fn),
    all: () => data,
  };
}

/** Fake phone-app server (the rules its /api/sync route follows). */
function fakeServer(values, setOnServer = []) {
  const server = { values: { ...values }, set: new Set(setOnServer), requests: [], down: false };
  server.fetch = async (url, init) => {
    if (server.down) throw new Error('offline');
    server.requests.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (init.method === 'PATCH') {
      for (const [k, v] of Object.entries(JSON.parse(init.body))) { server.values[k] = v; server.set.add(k); }
    }
    return new Response(JSON.stringify({ values: server.values, setOnServer: [...server.set] }), { status: 200 });
  };
  return server;
}

const DEFAULTS = { calendarVisibility: {}, taskListVisibility: {}, defaultCalendarId: null, defaultTaskListId: null, defaultEventMinutes: 60, timeFormat: 'system', weekStartsOn: 0, notifyMinutes: 10, userProfile: null };

function setup(local, server) {
  const prefs = fakePrefs({ ...DEFAULTS, ...local });
  const applied = [];
  const sync = createSync({ prefs, getToken: async () => 'google-token', fetch: server.fetch, onApplied: (keys) => applied.push(keys) });
  prefs.onChange((c) => sync.onLocalChange(c));
  return { prefs, sync, applied };
}

test('first link: what the phone already changed wins; the PC fills in the rest', async () => {
  const server = fakeServer({ ...DEFAULTS, timeFormat: '24' }, ['timeFormat']);
  const { prefs, sync, applied } = setup({ timeFormat: '12', weekStartsOn: 1, defaultEventMinutes: 30, view: 'month' }, server);
  const st = await sync.syncNow();
  assert.equal(st.error, '');
  assert.equal(prefs.get('timeFormat'), '24', 'phone wins for a setting it changed');
  assert.equal(server.values.weekStartsOn, 1, 'PC value sent for the others');
  assert.equal(server.values.defaultEventMinutes, 30);
  assert.equal(server.requests[0].auth, 'Bearer google-token');
  assert.ok(!('view' in server.requests[1].body), 'per-device settings never sent');
  assert.deepEqual(applied, [['timeFormat']]);
  assert.equal(prefs.get('syncLinked'), true);
  assert.deepEqual(prefs.get('syncDirty'), [], 'taking the phone\'s value is not a local change');
});

test('a change on the PC is sent; a change on the phone comes back', async () => {
  const server = fakeServer({ ...DEFAULTS }, []);
  const { prefs, sync, applied } = setup({ syncLinked: true }, server);
  prefs.set({ notifyMinutes: 15, view: 'week' });
  assert.deepEqual(prefs.get('syncDirty'), ['notifyMinutes'], 'only shared keys are queued');
  await sync.syncNow();
  assert.equal(server.values.notifyMinutes, 15);
  assert.deepEqual(prefs.get('syncDirty'), []);
  // now the phone changes something
  server.values.calendarVisibility = { 'work@group': false };
  await sync.syncNow();
  assert.deepEqual(prefs.get('calendarVisibility'), { 'work@group': false });
  assert.deepEqual(applied.at(-1), ['calendarVisibility']);
});

test('offline: the change is kept and sent next time', async () => {
  const server = fakeServer({ ...DEFAULTS }, []);
  const { prefs, sync } = setup({ syncLinked: true }, server);
  server.down = true;
  prefs.set({ weekStartsOn: 1 });
  const st = await sync.syncNow();
  assert.match(st.error, /Can't reach the phone app/);
  assert.deepEqual(prefs.get('syncDirty'), ['weekStartsOn']);
  server.down = false;
  assert.equal((await sync.syncNow()).error, '');
  assert.equal(server.values.weekStartsOn, 1);
});

test('nothing happens until an address is set; addresses are checked', async () => {
  const server = fakeServer({ ...DEFAULTS }, []);
  const { prefs, sync } = setup({ syncUrl: null }, server);
  prefs.set({ timeFormat: '24' });
  await sync.syncNow();
  assert.equal(server.requests.length, 0);
  assert.equal(cleanUrl('https://desk-calendar.me.workers.dev/'), 'https://desk-calendar.me.workers.dev');
  assert.equal(cleanUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.throws(() => cleanUrl('http://desk.example.com'));
  assert.throws(() => cleanUrl('https://desk.example.com/path'));
  assert.equal(cleanUrl(''), '');
  assert.deepEqual(SHARED_KEYS.sort(), Object.keys(DEFAULTS).sort(), 'the shared settings');
});
