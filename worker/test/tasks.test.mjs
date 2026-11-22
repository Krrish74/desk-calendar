// Tests for the Worker's Google Tasks port (src/tasks.js) and task deletes in the Undo
// queue (src/deletes.js). Runs against the fake Google (mock-google.js) and a SQLite
// stand-in for D1; the "API disabled" case uses a stubbed Google response.
// Run: npm test (in worker/).

process.env.TZ = 'UTC'; // like a Cloudflare Worker
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tasks = await import('../src/tasks.js');
const deletes = await import('../src/deletes.js');
const { getPrefs } = await import('../src/prefs.js');
const { encrypt } = await import('../src/crypto.js');
const { ymdIn, addDaysYmd } = await import('../src/tz.js');

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

const TZ = 'America/New_York'; // the fake data is laid out in this zone
const EMAIL = 'sample@example.com';
const FULL = 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks';
const env = { DB: d1(), MOCK_GOOGLE: '1', TOKEN_KEY: 'k'.repeat(40) };
env.DB.raw.prepare('INSERT INTO accounts (email, refresh_token, scope, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(EMAIL, 'x', FULL);
const ctx = async () => ({ env, email: EMAIL, tz: TZ, prefs: await getPrefs(env.DB, EMAIL), waitUntil: () => {} });
const today = ymdIn(new Date(), TZ);
const titles = (list) => list.map((t) => t.title).sort();

test('lists, and tasks due in a range', async () => {
  const c = await ctx();
  const lists = await tasks.listTaskLists(c, { fresh: true });
  assert.deepEqual(lists.map((l) => l.name), ['My Tasks', 'Work tasks']);
  assert.ok(lists.every((l) => l.visible));
  const todayOnly = await tasks.listTasks(c, { fromDay: today, toDay: addDaysYmd(today, 1) });
  assert.deepEqual(titles(todayOnly), ['Buy groceries', 'Call mom'], 'today, including the completed one');
  assert.equal(todayOnly.find((t) => t.title === 'Buy groceries').completed, true);
});

test('overdue tasks come with "today"; undated ones on request; completed can be left out', async () => {
  const c = await ctx();
  const list = await tasks.listTasks(c, { fromDay: today, toDay: addDaysYmd(today, 1), includeOverdue: true, includeUndated: true, includeCompleted: false });
  assert.deepEqual(titles(list), ['Book dentist', 'Call mom', 'Pay rent', 'Plan team offsite', 'Review pull request']);
  const rent = list.find((t) => t.title === 'Pay rent');
  assert.equal(rent.overdue, true);
  assert.equal(rent.due, addDaysYmd(today, -2));
  assert.equal(list.at(-1).due, null, 'undated tasks sort last');
  assert.deepEqual(Object.keys(rent).sort(), ['completed', 'due', 'id', 'kind', 'listId', 'listName', 'notes', 'overdue', 'title', 'webViewLink']);
});

test('hidden lists are skipped', async () => {
  let c = await ctx();
  await tasks.setListVisible(c, 'list-work', false);
  c = await ctx();
  const list = await tasks.listTasks(c, { fromDay: today, toDay: addDaysYmd(today, 7), includeOverdue: true });
  assert.ok(!list.some((t) => t.listId === 'list-work'));
  await tasks.setListVisible(c, 'list-work', true);
});

test('create, complete, reopen, move and clear the due date', async () => {
  const c = await ctx();
  const t = await tasks.createTask(c, { title: '  Water plants  ', due: addDaysYmd(today, 1), notes: 'Balcony' });
  assert.equal(t.title, 'Water plants');
  assert.equal(t.listId, 'list-main', 'default list');
  assert.equal(t.due, addDaysYmd(today, 1));
  let u = await tasks.updateTask(c, { listId: t.listId, taskId: t.id, completed: true });
  assert.equal(u.completed, true);
  u = await tasks.updateTask(c, { listId: t.listId, taskId: t.id, completed: false });
  assert.equal(u.completed, false);
  u = await tasks.updateTask(c, { listId: t.listId, taskId: t.id, due: null, title: 'Water the plants' });
  assert.equal(u.due, null);
  assert.equal(u.title, 'Water the plants');
  await assert.rejects(tasks.createTask(c, { title: '   ' }), /needs a title/);
  await assert.rejects(tasks.updateTask(c, { listId: t.listId, taskId: t.id, due: 'friday' }), /should look like/);
});

test('a task delete goes through the Undo queue', async () => {
  const c = await ctx();
  const t = await tasks.createTask(c, { title: 'Temporary', due: today });
  const token = await deletes.queueDelete(c, { kind: 'task', listId: t.listId, taskId: t.id }, { startNow: false });
  assert.ok((await deletes.pendingTaskKeys(c)).has(`${t.listId}|${t.id}`));
  assert.equal((await deletes.pendingKeys(c)).size, 0, 'not mixed up with events');
  env.DB.raw.prepare('UPDATE pending_deletes SET due_at = ? WHERE token = ?').run(Date.now() - 1, token);
  assert.equal(await deletes.runDue(env), 1, 'the cron sweep deletes it');
  const left = await tasks.listTasks(c, { fromDay: today, toDay: addDaysYmd(today, 1) });
  assert.ok(!left.some((x) => x.id === t.id), 'gone from Google');
});

test('older sign-ins without the Tasks permission get TASKS_SCOPE', async () => {
  env.DB.raw.prepare('UPDATE accounts SET scope = ?').run(FULL.replace(' https://www.googleapis.com/auth/tasks', ''));
  const c = await ctx();
  assert.equal(await tasks.hasTasksScope(c), false);
  await assert.rejects(tasks.listTasks(c, { fromDay: today, toDay: addDaysYmd(today, 1) }), (e) => e.code === 'TASKS_SCOPE' && e.status === 403);
  env.DB.raw.prepare('UPDATE accounts SET scope = ?').run(FULL);
});

test('a disabled Tasks API becomes TASKS_API_DISABLED; missing permission at Google becomes TASKS_SCOPE', async () => {
  const realEnv = { ...env, MOCK_GOOGLE: undefined, GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' };
  env.DB.raw.prepare('UPDATE accounts SET access_token = ?, access_expires = ?').run(await encrypt(env.TOKEN_KEY, 'tok'), Date.now() + 3600e3);
  const c = { ...(await ctx()), env: realEnv, email: EMAIL };
  const realFetch = globalThis.fetch;
  let reply;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith('https://tasks.googleapis.com/tasks/v1/'));
    return new Response(JSON.stringify({ error: { code: 403, message: reply } }), { status: 403 });
  };
  try {
    reply = 'Google Tasks API has not been used in project 123 before or it is disabled.';
    await assert.rejects(tasks.listTaskLists(c, { fresh: true }), (e) => e.code === 'TASKS_API_DISABLED');
    reply = 'Request had insufficient authentication scopes.';
    await assert.rejects(tasks.listTaskLists(c, { fresh: true }), (e) => e.code === 'TASKS_SCOPE');
  } finally {
    globalThis.fetch = realFetch;
  }
});
