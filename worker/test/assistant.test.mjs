// Tests for the Worker's assistant port (src/assistant.js): prompt caching markers, the
// deterministic system prompt with the About-you profile, "plan first, create after
// yes", short ids kept between requests, task tools, limits and cost tracking.
//
// Runs the real Worker code in Node against the fake Google (mock-google.js), a SQLite
// stand-in for D1, and a scripted Claude: every request the SDK sends is recorded so
// we can inspect it. Run: npm test (in worker/).

process.env.TZ = 'UTC'; // like a Cloudflare Worker: the server clock is UTC, the user isn't
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const assistant = await import('../src/assistant.js');
const calendar = await import('../src/calendar.js');
const deletes = await import('../src/deletes.js');
const { getPrefs, setPrefs } = await import('../src/prefs.js');

// --- D1 stand-in -------------------------------------------------------------------------
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

const TZ = 'America/New_York';
const EMAIL = 'sample@example.com';
const env = { DB: d1(), MOCK_GOOGLE: '1', ANTHROPIC_API_KEY: 'sk-ant-test', ALLOWED_EMAILS: EMAIL };
env.DB.raw.prepare('INSERT INTO accounts (email, refresh_token, scope, created_at, updated_at) VALUES (?, ?, ?, 0, 0)')
  .run(EMAIL, 'x', 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks');
const ctx = async () => ({ env, email: EMAIL, tz: TZ, prefs: await getPrefs(env.DB, EMAIL), waitUntil: () => {} });

// --- Scripted Claude -----------------------------------------------------------------------
const sent = [];      // request bodies, in order
let script = [];      // functions (body) => message JSON, one per request
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  sent.push(body);
  const next = script.shift();
  if (!next) throw new Error('Claude was called more times than the test expected');
  return new Response(JSON.stringify(next(body)), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
};
let id = 0;
const usage = { input_tokens: 100, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 200 };
const msg = (content, stop_reason) => ({ id: `msg_${++id}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_sequence: null, usage });
const tools = (...calls) => () => msg(calls.map(([name, input]) => ({ type: 'tool_use', id: `toolu_${++id}`, name, input })), 'tool_use');
const say = (t) => () => msg([{ type: 'text', text: t }], 'end_turn');
/** The tool results Claude received in the last request: { tool_use_id: parsed JSON | error text }. */
const lastResults = (body) => Object.fromEntries(body.messages.at(-1).content.map((r) => [r.tool_use_id, r.is_error ? { error: r.content } : JSON.parse(r.content)]));

const chat = async (text) => {
  const c = await ctx();
  const hidden = await deletes.pendingKeys(c);
  const hiddenTasks = await deletes.pendingTaskKeys(c);
  return assistant.send(c, text, { queueDelete: (item) => deletes.queueDelete(c, item, { startNow: false }), hidden, hiddenTasks });
};
const allEvents = async () => calendar.listEvents(await ctx(), new Date(Date.now() - 2 * 864e5), new Date(Date.now() + 20 * 864e5));
const ymd = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------

test('requests carry the caching markers; the system prompt is stable and has no timestamp', async () => {
  await setPrefs(env.DB, EMAIL, { userProfile: { dayStart: '08:30', dayEnd: '16:30', focusTime: 'morning', blockColorId: '5', notes: 'No meetings on Friday afternoons.' } });
  sent.length = 0;
  script = [say('Hi!'), say('Still here.')];
  await chat('hello');
  await chat('again');
  const [a, b] = sent;
  assert.equal(a.system.length, 1);
  assert.deepEqual(a.system[0].cache_control, { type: 'ephemeral' }, 'breakpoint on the system prompt');
  assert.deepEqual(a.cache_control, { type: 'ephemeral' }, 'top-level automatic caching');
  assert.equal(a.system[0].text, b.system[0].text, 'system prompt is byte-identical between requests');
  assert.deepEqual(a.tools, b.tools, 'tools identical (part of the cached prefix)');
  // Same tools, in the same order, as the desktop app (read from its source).
  const desktopSrc = readFileSync(fileURLToPath(new URL('../../src/main/assistant.js', import.meta.url)), 'utf8');
  const desktopTools = [...desktopSrc.slice(desktopSrc.indexOf('const TOOLS = ['), desktopSrc.indexOf('// Short ids')).matchAll(/name: '(\w+)'/g)].map((x) => x[1]);
  assert.deepEqual(a.tools.map((t) => t.name), desktopTools);
  assert.equal(desktopTools.length, 10);
  const sys = a.system[0].text;
  assert.ok(!sys.includes(ymd(new Date())) && !/\[Now:/.test(sys), 'no date or time in the system prompt');
  assert.ok(sys.includes(`The user's timezone is ${TZ}.`));
  assert.ok(sys.includes('- If your plan has two or more blocks, reply with it as a short bullet list (day, time, task) and ask whether to add them. Create nothing until the user agrees. A single block the user asked for directly: just create it.'), 'planning rule copied verbatim');
  assert.ok(sys.includes('working hours 08:30–16:30') && sys.includes('Best focus time: morning') && sys.includes('In their own words: No meetings on Friday afternoons.'), 'profile rendered into the prompt');
  assert.match(a.messages[0].content, /^\[Now: \d{4}-\d\d-\d\dT\d\d:\d\d \(\w{3}\), America\/New_York\]\nhello$/, 'the time goes in the user message');
  assert.equal(b.messages.length, 3, 'second message continues the conversation');
});

test('plan first, create after yes (with linked, colored blocks and short ids across requests)', async () => {
  await assistant.reset(await ctx());
  const before = (await allEvents()).length;
  const today = ymd(new Date());
  const inWeek = ymd(new Date(Date.now() + 6 * 864e5));
  let taskRef, slot;
  sent.length = 0;
  script = [
    tools(['list_tasks', { start_date: today, end_date: inWeek, include_undated: true }], ['find_free_time', { start_date: today, end_date: inWeek }]),
    (body) => {
      const results = Object.values(lastResults(body));
      const taskList = results.find(Array.isArray);
      const free = results.find((r) => r.days);
      taskRef = taskList.find((t) => t.title === 'Write Q4 report');
      const day = free.days.find((d) => d.free.length);
      slot = { day: day.date.slice(0, 10), from: day.free[0].split('-')[0] };
      return msg([{ type: 'text', text: `Plan:\n- ${slot.day} ${slot.from}: Write Q4 report (1h)\n- ${slot.day} later: Write Q4 report (1h)\nShall I add these?` }], 'end_turn');
    },
  ];
  const r1 = await chat('plan my week');
  assert.equal(sent.length, 2, 'one round trip for both tools, then the plan');
  assert.equal(sent[1].messages.at(-1).content.length, 2, 'both tool results sent back in one message');
  assert.match(r1.reply, /Shall I add these/);
  assert.equal(r1.actions.length, 0);
  assert.equal((await allEvents()).length, before, 'nothing created before the user agrees');
  assert.match(taskRef.list_id, /^l\d+$/, 'task lists appear as short ids');
  assert.equal(JSON.stringify(sent[1].messages.at(-1)).includes('list-work'), false, 'the long list id is never sent to Claude');

  const [h, m] = slot.from.split(':').map(Number);
  const at = (hh) => `${slot.day}T${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  script = [
    tools(['create_event', { title: 'Write Q4 report', start: at(h), end: at(h + 1), task_id: taskRef.task_id, list_id: taskRef.list_id }],
      ['create_event', { title: 'Write Q4 report', start: at(h + 2), end: at(h + 3), task_id: taskRef.task_id, list_id: taskRef.list_id }]),
    say('Added 2 blocks.'),
  ];
  const r2 = await chat('yes');
  assert.equal(r2.actions.filter((a) => a.kind === 'created').length, 2, 'both blocks created after "yes"');
  const blocks = (await allEvents()).filter((e) => e.taskLink);
  assert.equal(blocks.length, 2);
  for (const ev of blocks) {
    assert.equal(ev.taskLink, `list-work|${taskRef.task_id}`, 'linked to the task with the REAL list id (alias kept between requests)');
    assert.ok(ev.description.includes('Time block for task: Write Q4 report'));
    assert.equal(ev.colorId, '5', 'the profile\'s block color');
    assert.equal(new Date(ev.start).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).padStart(2, '0').slice(-2) * 1 >= 0, true);
  }
  const startLocal = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(blocks.sort((x, y) => new Date(x.start) - new Date(y.start))[0].start));
  assert.equal(startLocal, slot.from, 'Claude\'s local time lands at that time in the phone\'s zone');
});

test('find_free_time works in the phone\'s zone while the server runs in UTC', () => {
  const chicago = 'America/Chicago';
  const profile = { workDays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', lunchStart: '12:00', lunchEnd: '13:00', meetingBuffer: 15 };
  const longAgo = new Date('2000-01-01T00:00:00Z');
  // 10:00–11:00 in Chicago on Mon 2026-11-23 = 16:00–17:00 UTC
  const events = [{ start: '2026-11-23T16:00:00Z', end: '2026-11-23T17:00:00Z' }];
  const [day] = assistant.freeSlotsInZone(chicago, { fromDay: '2026-11-23', toDay: '2026-11-24', events, profile, minMinutes: 30, now: longAgo });
  assert.equal(day.weekday, 'Mon');
  assert.deepEqual(day.slots.map((s) => `${s.start}-${s.end}`), ['09:00-09:45', '11:15-12:00', '13:00-17:00'], 'same answer as the desktop test');
  // DST day (Chicago falls back on Sun 2026-11-01): still exactly 8 working hours
  const [dst] = assistant.freeSlotsInZone(chicago, { fromDay: '2026-11-01', toDay: '2026-11-02', events: [], profile: { ...profile, lunchStart: '', lunchEnd: '' }, minMinutes: 30, anyDay: true, now: longAgo });
  assert.equal(dst.free_minutes, 480);
  // Time already past (it's 14:07 in Chicago) isn't free
  const [late] = assistant.freeSlotsInZone(chicago, { fromDay: '2026-11-23', toDay: '2026-11-24', events: [], profile, minMinutes: 30, now: new Date('2026-11-23T20:07:00Z') });
  assert.deepEqual(late.slots.map((s) => `${s.start}-${s.end}`), ['14:10-17:00']);
});

test('task tools: create, complete, clear due date ("none"), delete with Undo', async () => {
  await assistant.reset(await ctx());
  let made;
  script = [
    tools(['create_task', { title: 'Call the bank', due_date: ymd(new Date()) }]),
    (body) => { made = Object.values(lastResults(body))[0]; return msg([{ type: 'text', text: 'Added.' }], 'end_turn'); },
  ];
  const r1 = await chat('add a task to call the bank today');
  assert.equal(r1.actions[0].kind, 'task-created');
  assert.match(made.list_id, /^l\d+$/);
  assert.match(made.due, /^\d{4}-\d\d-\d\d \(\w{3}\)$/, 'due date shown with its weekday');

  script = [
    tools(['update_task', { list_id: made.list_id, task_id: made.task_id, completed: true }], ['update_task', { list_id: made.list_id, task_id: made.task_id, due_date: 'none' }]),
    (body) => { const out = Object.values(lastResults(body)); assert.equal(out.at(-1).due, null, '"none" removed the due date'); return msg([{ type: 'text', text: 'Done.' }], 'end_turn'); },
  ];
  const r2 = await chat('mark it done and remove the date');
  assert.deepEqual(r2.actions.map((a) => a.kind).sort(), ['task-completed', 'task-updated']);

  script = [tools(['delete_task', { list_id: made.list_id, task_id: made.task_id, title: 'Call the bank' }]), say('Deleted.')];
  const r3 = await chat('delete it');
  const card = r3.actions[0];
  assert.equal(card.kind, 'deleted');
  assert.equal(card.isTask, true);
  const pending = env.DB.raw.prepare("SELECT kind, event_id FROM pending_deletes WHERE token = ?").get(card.token);
  assert.deepEqual({ ...pending }, { kind: 'task', event_id: made.task_id }, 'queued in the Undo queue as a task');
  assert.equal(await deletes.cancelDelete(await ctx(), card.token), true, 'Undo works');
});

test('ranges are capped at 31 days; errors go back to Claude', async () => {
  await assistant.reset(await ctx());
  script = [
    tools(['list_events', { start_date: '2026-11-01', end_date: '2026-12-15' }]),
    (body) => { const [r] = Object.values(lastResults(body)); assert.match(r.error, /at most 31 days/); return msg([{ type: 'text', text: 'Too long.' }], 'end_turn'); },
  ];
  await chat('what is on until mid december');
});

test('a fresh conversation after 30 idle minutes or 20 messages', async () => {
  await assistant.reset(await ctx());
  sent.length = 0;
  script = [say('one'), say('two')];
  await chat('first');
  env.DB.raw.prepare('UPDATE chats SET updated_at = ?').run(Date.now() - 31 * 60e3);
  const r = await chat('after a break');
  assert.equal(r.freshStart, true);
  assert.equal(sent[1].messages.length, 1, 'old history not re-sent');

  await assistant.reset(await ctx());
  script = Array.from({ length: 21 }, (_, i) => say(`reply ${i}`));
  sent.length = 0;
  let last;
  for (let i = 0; i < 21; i++) last = await chat(`message ${i}`);
  assert.equal(sent[19].messages.length, 39, '20th message still continues');
  assert.equal(last.freshStart, true, '21st message starts fresh');
  assert.equal(sent[20].messages.length, 1);
});

test('usage and cost are recorded per message and per month', async () => {
  await env.DB.prepare('UPDATE prefs SET json = json_remove(json, \'$.assistantUsage\') WHERE email = ?').bind(EMAIL).run();
  script = [tools(['list_calendars', {}]), say('You have 5 calendars.')];
  const r = await chat('which calendars do I have');
  // 2 requests × (100 in + 3000 cache write + 200 out) at Haiku 5.5 prices
  const expected = 2 * (100 * 0.10 + 3000 * 0.10 * 1.25 + 200 * 0.50) / 1e6;
  assert.equal(r.requests, 2);
  assert.ok(Math.abs(r.cost - expected) < 1e-12, `cost ${r.cost} ≈ ${expected}`);
  const u = assistant.getSettings(await ctx()).usage;
  assert.equal(u.messages, 1);
  assert.equal(u.requests, 2);
  assert.ok(Math.abs(u.last.cost - expected) < 1e-12);
  script = [say('ok')];
  await chat('thanks');
  const u2 = assistant.getSettings(await ctx()).usage;
  assert.equal(u2.messages, 2);
  assert.ok(u2.cost > u.cost, 'monthly total grows');
  assert.equal(u2.month, new Date().toISOString().slice(0, 7));
});

test('profile and settings are exposed for the phone', async () => {
  const s = assistant.getSettings(await ctx());
  assert.equal(s.current, 'claude-haiku-5-5');
  assert.equal(s.models.length, 3);
  assert.equal(s.profile.dayStart, '08:30');
  assert.equal(s.profileDefaults.dayStart, '09:00');
});
