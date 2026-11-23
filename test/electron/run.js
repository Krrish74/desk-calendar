// Electron test runner: assistant tests against mock AI servers, then UI tests in a real window.
// Google is stubbed (no network, no sign-in), and a throwaway userData folder keeps your real
// prefs and keys untouched. Run with: npm test   (or: npx electron test/electron/run.js)
const { app } = require('electron');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SRC = path.join(__dirname, '..', '..', 'src', 'main');
const SHOTS = process.env.SHOTS_DIR || ''; // set to save screenshots (see docs/screenshots)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until check() is truthy (or time out), so tests don't depend on fixed delays. */
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v || Date.now() > end) return v;
    await wait(100);
  }
}

app.disableHardwareAcceleration();
for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'ASSISTANT_API_KEY']) delete process.env[k];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
app.setPath('userData', userData);

// --- tiny test harness --------------------------------------------------------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✔ ${name}`); }
  catch (err) { results.push([false, name]); console.log(`  ✖ ${name}\n      ${err.stack?.split('\n').slice(0, 3).join('\n      ')}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
}
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }

// --- sample data -----------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date(); today.setHours(0, 0, 0, 0);
const day = (n, h = 0, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n, h, m);
const WORK_CAL = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6@group.calendar.google.com';
const LIST_ID = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA6MDow';
const CALS = [
  { id: 'you@example.com', name: 'Personal', color: '#4285f4', primary: true, canEdit: true, visible: true, googleSelected: true, defaultReminders: [] },
  { id: WORK_CAL, name: 'Work', color: '#0b8043', canEdit: true, visible: true, googleSelected: true, defaultReminders: [] },
];
const ev = (id, cal, title, start, end) => ({
  id, calendarId: cal.id, calendarName: cal.name, canEdit: true, title, location: '', description: '', allDay: false,
  start: start.toISOString(), end: end.toISOString(), color: cal.color, meetLink: '', hasGoogleMeet: false, colorId: '', reminders: { useDefault: true }, htmlLink: '', taskLink: '',
});
const EVENTS = [
  ev('e1', CALS[1], 'Standup', day(1, 9), day(1, 9, 30)),
  ev('e2', CALS[0], 'Gym', day(1, 18), day(1, 19)),
];
const task = (id, title, due, extra = {}) => ({
  kind: 'task', id, listId: LIST_ID, listName: 'My Tasks', title, notes: '', due, completed: false,
  overdue: !!due && due < ymd(today), webViewLink: '', ...extra,
});
let TASKS = [];
function resetTasks() {
  TASKS = [
    task('t1', 'Finish lab report', ymd(day(-2))),              // overdue
    task('t2', 'Email advisor', ymd(day(0))),
    task('t3', 'Read chapter 5', ymd(day(0)), { completed: true }),
    task('t4', 'Study for physics quiz', ymd(day(2))),
    task('t5', 'Plan trip', null),
  ];
}
resetTasks();

// --- stub Google (calendar.js, tasks.js, auth.js) -------------------------------
const calls = { createEvent: [], updateEvent: [], createTask: [], updateTask: [], deleteTask: [], deleteEvent: [] };
const auth = require(path.join(SRC, 'auth.js'));
let tasksConnected = true;
Object.assign(auth, { hasCredentials: () => true, isSignedIn: () => true, hasTasksScope: () => tasksConnected, signIn: async () => { tasksConnected = true; } });
const calendar = require(path.join(SRC, 'calendar.js'));
Object.assign(calendar, {
  listCalendars: async () => CALS,
  listEvents: async (from, to) => EVENTS.filter((e) => new Date(e.end) > from && new Date(e.start) < to),
  getEvent: async ({ eventId }) => { const e = EVENTS.find((x) => x.id === eventId); return { start: { dateTime: e.start }, end: { dateTime: e.end } }; },
  createEvent: async (p) => { calls.createEvent.push(p); return { id: `new${calls.createEvent.length}`, title: p.title, allDay: false, start: new Date(p.start).toISOString(), end: new Date(p.end || new Date(new Date(p.start).getTime() + 3600e3)).toISOString() }; },
  updateEvent: async (p) => { calls.updateEvent.push(p); return { id: p.eventId, title: p.title || 'x', allDay: false, start: new Date(p.start || day(1, 9)).toISOString(), end: new Date(p.end || day(1, 10)).toISOString() }; },
  deleteEvent: async (p) => { calls.deleteEvent.push(p); return { deleted: true }; },
});
const tasks = require(path.join(SRC, 'tasks.js'));
const tasksError = () => Object.assign(new Error('Connect Google Tasks to see your tasks.'), { code: 'TASKS_SCOPE' });
Object.assign(tasks, {
  listTaskLists: async () => { if (!tasksConnected) throw tasksError(); return [{ id: LIST_ID, name: 'My Tasks', visible: true }]; },
  listTasks: async ({ from, to, includeOverdue, includeUndated, includeCompleted = true }) => {
    if (!tasksConnected) throw tasksError();
    const f = from ? ymd(from) : null, t = to ? ymd(to) : null;
    return TASKS.filter((x) => (f && x.due && x.due >= f && x.due < t && (includeCompleted || !x.completed))
      || (includeOverdue && x.overdue && !x.completed) || (includeUndated && !x.due && !x.completed));
  },
  createTask: async (p) => { calls.createTask.push(p); const t = task(`n${calls.createTask.length}`, p.title, p.due || null); TASKS.push(t); return t; },
  updateTask: async (p) => {
    calls.updateTask.push(p);
    const t = TASKS.find((x) => x.id === p.taskId);
    if (p.completed !== undefined) t.completed = p.completed;
    if (p.due !== undefined) t.due = p.due;
    if (p.title !== undefined) t.title = p.title;
    t.overdue = !t.completed && !!t.due && t.due < ymd(today);
    return { ...t };
  },
  deleteTask: async (p) => { calls.deleteTask.push(p); TASKS = TASKS.filter((x) => x.id !== p.taskId); return { deleted: true }; },
});

// --- mock AI servers ----------------------------------------------------------------
// script: a queue of functions (requestBody) → response; each request pops one.
let script = [];
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = body ? JSON.parse(body) : null;
    requests.push({ url: req.url, headers: req.headers, body: b });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET') return send(200, { data: [{ id: 'mock-model' }] });
    const next = script.shift();
    if (!next) return send(500, { error: { message: 'mock script empty' } });
    const out = next(b);
    if (req.url.startsWith('/v1/messages')) {
      return send(200, { id: 'msg', type: 'message', role: 'assistant', model: b.model, stop_sequence: null, ...out });
    }
    return send(200, out);
  });
});

/** Claude mock reply helpers. */
const U = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
const claudeTools = (...uses) => () => ({ stop_reason: 'tool_use', usage: U(50, 3000, 0, 40), content: uses.map(([name, input], i) => ({ type: 'tool_use', id: `tu_${name}_${i}_${Math.random().toString(36).slice(2, 6)}`, name, input })) });
const claudeText = (text) => () => ({ stop_reason: 'end_turn', usage: U(60, 0, 3200, 30), content: [{ type: 'text', text }] });
const lastToolResults = (b) => b.messages[b.messages.length - 1].content.filter((c) => c.type === 'tool_result').map((c) => JSON.parse(c.content));

// =====================================================================================
// Assistant tests
// =====================================================================================
async function assistantTests(base) {
  console.log('\nAssistant (mock Claude / OpenAI-compatible servers)');
  process.env.ANTHROPIC_BASE_URL = base;
  const prefs = require(path.join(SRC, 'prefs.js'));
  const assistant = require(path.join(SRC, 'assistant.js'));
  const store = require(path.join(SRC, 'secureStore.js'));
  await store.save('anthropic-key', 'sk-ant-test-0000000000000');
  prefs.set({ assistantProvider: 'anthropic', assistantModel: 'claude-haiku-5-5', userProfile: { focusTime: 'morning', notes: 'I study best before noon.', blockColorId: '9' } });

  const queued = [];
  const ctx = { onChanged: () => {}, queueDelete: (item) => { queued.push(item); return queued.length; } };
  const send = (text) => assistant.send(text, ctx);

  await test('Claude request: cached system prompt + automatic caching + all 10 tools', async () => {
    assistant.reset(); requests.length = 0;
    script = [claudeText('Hi!')];
    await send('hello');
    const b = requests[0].body;
    ok(Array.isArray(b.system) && b.system[0].cache_control?.type === 'ephemeral', 'system breakpoint');
    eq(b.cache_control, { type: 'ephemeral' }, 'top-level cache_control');
    eq(b.tools.map((t) => t.name), ['list_calendars', 'list_events', 'create_event', 'update_event', 'delete_event', 'list_tasks', 'create_task', 'update_task', 'delete_task', 'find_free_time']);
    ok(b.system[0].text.includes('Best focus time: morning') && b.system[0].text.includes('I study best before noon.'), 'profile in system prompt');
    ok(!b.system[0].text.includes(ymd(new Date())), 'no current date/time in the system prompt (it would break the cache)');
    ok(b.messages[0].content.startsWith('[Now: '), 'current time goes in the user message');
  });

  await test('system + tools stay byte-identical across turns; a profile edit changes them', async () => {
    requests.length = 0;
    script = [claudeText('a'), claudeText('b')];
    await send('one'); await send('two');
    const s1 = JSON.stringify([requests[0].body.system, requests[0].body.tools]);
    const s2 = JSON.stringify([requests[1].body.system, requests[1].body.tools]);
    eq(s1 === s2, true, 'prefix identical');
    assistant.setSettings({ profile: { ...prefs.get('userProfile'), focusTime: 'evening' } });
    requests.length = 0;
    script = [claudeText('c')];
    await send('three');
    ok(requests[0].body.system[0].text.includes('Best focus time: evening'), 'updated profile');
    eq(requests[0].body.messages.length, 1, 'profile change starts a new chat');
  });

  await test('plan my week: list_tasks + find_free_time in one turn, nothing created before "yes"', async () => {
    assistant.reset(); requests.length = 0; calls.createEvent.length = 0;
    script = [
      claudeTools(['list_tasks', { include_undated: true }], ['find_free_time', { start_date: ymd(day(1)), end_date: ymd(day(5)) }]),
      claudeText('Here is a plan:\n- Mon 9:00–10:30 Study for physics quiz\n- Mon 10:45–11:45 Finish lab report\nShall I add these?'),
    ];
    const r = await send('plan my week');
    const results = lastToolResults(requests[1].body);
    const taskList = results.find(Array.isArray);
    const free = results.find((x) => x.days);
    ok(taskList.some((t) => t.title === 'Finish lab report' && t.overdue), 'overdue task included');
    ok(taskList.some((t) => t.title === 'Plan trip' && t.due === null), 'undated task included');
    eq(taskList[0].list_id, 'l1', 'task list id is shortened');
    ok(free.days.length >= 1 && free.days.every((d) => /\(\w{3}\)$/.test(d.date)), 'free time per day');
    ok(!JSON.stringify(free).includes('09:00-09:30'), 'standup (and its buffer) is not free');
    eq(calls.createEvent.length, 0, 'no events created before confirming');
    eq(r.actions.length, 0);
  });

  await test('"yes": blocks are linked to tasks, colored, and mapped back to real ids', async () => {
    requests.length = 0;
    script = [
      claudeTools(
        ['create_event', { title: 'Study for physics quiz', start: `${ymd(day(1))}T10:00`, end: `${ymd(day(1))}T11:30`, task_id: 't4', list_id: 'l1' }],
        ['create_event', { title: 'Finish lab report', start: `${ymd(day(1))}T11:45`, end: `${ymd(day(1))}T12:45`, task_id: 't1', list_id: 'l1', calendar_id: 'c1' }],
      ),
      claudeText('Added both blocks.'),
    ];
    const r = await send('yes');
    eq(calls.createEvent.length, 2);
    eq(calls.createEvent[0].taskLink, `${LIST_ID}|t4`, 'task link uses the real list id');
    eq(calls.createEvent[0].colorId, '9', 'profile block color');
    ok(calls.createEvent[0].description.includes('Time block for task: Study for physics quiz'));
    eq(r.actions.map((a) => a.kind), ['created', 'created']);
    eq(calls.updateTask.length, 0, 'scheduling does not complete tasks');
  });

  await test('calendar ids are shortened to c1/c2 and resolved back for edits', async () => {
    assistant.reset(); requests.length = 0; calls.updateEvent.length = 0;
    script = [
      claudeTools(['list_events', { start_date: ymd(day(1)), end_date: ymd(day(1)) }]),
      (b) => { const evs = lastToolResults(b)[0]; const s = evs.find((e) => e.title === 'Standup'); return claudeTools(['update_event', { calendar_id: s.calendar_id, event_id: s.event_id, start: `${ymd(day(1))}T09:15` }])(); },
      claudeText('Moved.'),
    ];
    await send('move standup to 9:15');
    const evs = lastToolResults(requests[1].body)[0];
    ok(evs.every((e) => /^c\d$/.test(e.calendar_id)), 'aliases in results');
    ok(!JSON.stringify(evs).includes('group.calendar.google.com'), 'long id never sent');
    eq(calls.updateEvent[0].calendarId, WORK_CAL, 'alias resolved');
  });

  await test('task tools: add, complete, delete (queued with Undo)', async () => {
    assistant.reset(); queued.length = 0; calls.createTask.length = 0;
    script = [
      claudeTools(['create_task', { title: 'Buy notebook', due_date: ymd(day(1)) }]),
      claudeText('Added.'),
      claudeTools(['list_tasks', {}]),
      claudeTools(['update_task', { list_id: 'l1', task_id: 't2', completed: true }]),
      claudeText('Done.'),
      claudeTools(['delete_task', { list_id: 'l1', task_id: 't5', title: 'Plan trip' }]),
      claudeText('Deleted.'),
    ];
    const a = await send('add buy notebook tomorrow');
    eq(a.actions[0].kind, 'task-created');
    eq(calls.createTask[0].due, ymd(day(1)));
    const b = await send('I emailed my advisor');
    eq(b.actions[0].kind, 'task-completed');
    eq(TASKS.find((t) => t.id === 't2').completed, true);
    const c = await send('delete plan trip');
    eq(c.actions[0].kind, 'deleted');
    eq(c.actions[0].isTask, true);
    eq(queued[0], { kind: 'task', listId: LIST_ID, taskId: 't5' }, 'queued with the real list id');
    resetTasks();
  });

  await test('usage and cost are recorded (Haiku 5.5 prices, cache writes at 1.25×)', async () => {
    assistant.reset();
    script = [claudeTools(['list_tasks', {}]), claudeText('ok')];
    const r = await send('what are my tasks');
    eq(r.requests, 2);
    eq(r.usage, { input: 110, cacheWrite: 3000, cacheRead: 3200, output: 70 });
    const expected = (110 * 0.10 + 3000 * 0.10 * 1.25 + 3200 * 0.01 + 70 * 0.50) / 1e6;
    ok(Math.abs(r.cost - expected) < 1e-12, `cost ${r.cost} vs ${expected}`);
    const u = prefs.get('assistantUsage');
    ok(u.messages >= 1 && u.cost > 0 && u.last.requests === 2, 'monthly total saved');
  });

  await test('a long pause starts a fresh conversation (old history is not re-sent)', async () => {
    assistant.reset(); requests.length = 0;
    script = [claudeText('a'), claudeText('b')];
    await send('first');
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60 * 1000;
    try {
      const r = await send('second, much later');
      eq(r.freshStart, true);
      eq(requests[1].body.messages.length, 1, 'only the new message');
    } finally { Date.now = realNow; }
  });

  await test('range limits: more than 31 days is refused politely', async () => {
    assistant.reset(); requests.length = 0;
    script = [claudeTools(['list_events', { start_date: ymd(day(0)), end_date: ymd(day(90)) }]), claudeText('Narrower then.')];
    await send('everything for 3 months');
    const block = requests[1].body.messages.at(-1).content[0];
    eq(block.is_error, true);
    ok(/at most 31 days/.test(block.content));
  });

  await test('caching can be switched off (for the benchmark)', async () => {
    assistant.reset(); requests.length = 0;
    assistant.setCaching(false);
    script = [claudeText('x')];
    await send('hi');
    assistant.setCaching(true);
    eq(typeof requests[0].body.system, 'string');
    eq(requests[0].body.cache_control, undefined);
  });

  await test('OpenAI-compatible providers get the same task tools and a stable prefix', async () => {
    prefs.set({ assistantProvider: 'custom', assistantModels: { custom: 'mock-model' }, assistantBaseUrls: { custom: `${base}/v1` } });
    assistant.reset(); requests.length = 0;
    script = [
      () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }] } }], usage: { prompt_tokens: 3000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 2800 } } }),
      () => ({ choices: [{ message: { role: 'assistant', content: 'You have 3 tasks.' } }], usage: { prompt_tokens: 3200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 3000 } } }),
    ];
    const r = await send('tasks?');
    const b0 = requests[0].body, b1 = requests[1].body;
    eq(b0.tools.map((t) => t.function.name).length, 10);
    eq(b0.messages[0].role, 'system');
    eq(JSON.stringify([b0.messages[0], b0.tools]) === JSON.stringify([b1.messages[0], b1.tools]), true, 'prefix identical');
    eq(r.usage, { input: 400, cacheWrite: 0, cacheRead: 5800, output: 30 });
    eq(r.cost, null, 'no price known for a custom provider');
    prefs.set({ assistantProvider: 'anthropic' });
  });
}

// =====================================================================================
// UI tests
// =====================================================================================
function uiTests() {
  return new Promise((resolve) => {
    app.on('browser-window-created', (_, w) => {
      w.setSize(1400, 860);
      w.webContents.once('did-finish-load', async () => {
        const js = (c) => w.webContents.executeJavaScript(c);
        const shot = async (name) => {
          if (!SHOTS) return;
          await js(`document.documentElement.classList.remove('mica'); document.documentElement.style.background = '#16181d'`);
          w.webContents.invalidate(); await wait(700);
          fs.writeFileSync(path.join(SHOTS, name), (await w.webContents.capturePage()).toPNG());
        };
        console.log('\nUI (real window, stubbed Google)');
        await wait(2500);

        await test('sidebar shows today\'s tasks with overdue first', async () => {
          const rows = await js(`[...document.querySelectorAll('#tt-list .task-row')].map(r => r.querySelector('.task-title').textContent + '|' + (r.querySelector('.task-meta')?.textContent || ''))`);
          eq(rows.length, 2, 'open tasks');
          ok(rows[0].startsWith('Finish lab report|Overdue'), rows[0]);
          eq(rows[1], 'Email advisor|');
          eq(await js(`$('tt-done-toggle').textContent`), 'Show done (1)');
        });

        await test('ticking a task saves it and moves it to Done', async () => {
          calls.updateTask.length = 0;
          await js(`document.querySelector('#tt-list .task-row[data-task-id="t2"] .task-check').click()`);
          await until(() => calls.updateTask.length);
          eq(calls.updateTask[0], { listId: LIST_ID, taskId: 't2', completed: true });
          const left = await until(async () => { const t = await js(`[...document.querySelectorAll('#tt-list .task-title')].map(e => e.textContent)`); return t.length === 1 && t; });
          eq(left, ['Finish lab report']);
          eq(await js(`$('tt-done-toggle').textContent`), 'Show done (2)');
        });

        await test('"Add a task" understands dates', async () => {
          calls.createTask.length = 0;
          await js(`$('tt-input').value = 'call mom in 3 days'; $('tt-input').dispatchEvent(new Event('input'))`);
          ok(await until(async () => (await js(`$('tt-preview').textContent`)).includes('Call mom')), 'preview');
          await js(`$('tt-add').requestSubmit()`);
          await until(() => calls.createTask.length === 1);
          eq(calls.createTask[0], { title: 'Call mom', due: ymd(day(3)) });
          await until(async () => (await js(`$('tt-input').value`)) === '');
          await js(`$('tt-input').value = 'water plants'; $('tt-add').requestSubmit()`);
          await until(() => calls.createTask.length === 2);
          eq(calls.createTask[1], { title: 'water plants', due: ymd(day(0)) }, 'no date = today');
        });

        await test('Agenda lists tasks per day, overdue on today', async () => {
          await js(`setView('agenda')`);
          await until(async () => (await js(`document.querySelectorAll('.ag-tasks .task-row').length`)) >= 5);
          const days = await js(`[...document.querySelectorAll('.ag-day')].map(d => d.querySelector('.ag-num').textContent + ':' + [...d.querySelectorAll('.ag-tasks .task-title')].map(t => t.textContent).join(','))`);
          ok(days[0].includes('Finish lab report') && days[0].includes('Email advisor'), days[0]);
          ok(days.some((d) => d.startsWith(`${day(2).getDate()}:`) && d.includes('Study for physics quiz')), 'future task on its day');
          ok(days.some((d) => d.startsWith(`${day(3).getDate()}:`) && d.includes('Call mom')), 'new task appears');
          await shot('agenda-tasks.png');
        });

        await test('task popover: delete with Undo keeps the task', async () => {
          calls.deleteTask.length = 0;
          await js(`document.querySelector('.ag-tasks .task-row[data-task-id="t4"] .task-text').click()`);
          await wait(300);
          ok(await js(`!!document.querySelector('.popover .task-details')`), 'popover opened');
          await js(`document.querySelector('.popover button[title="Delete"]').click()`);
          await wait(300);
          ok(await js(`!document.querySelector('.ag-tasks .task-row[data-task-id="t4"]')`), 'hidden right away');
          await js(`[...document.querySelectorAll('.toast button')].find(b => b.textContent === 'Undo').click()`);
          await wait(7000);
          eq(calls.deleteTask.length, 0, 'never deleted');
          ok(await js(`!!document.querySelector('.ag-tasks .task-row[data-task-id="t4"]')`), 'back after Undo');
        });

        await test('Settings → About you saves the profile', async () => {
          await js(`openSettings()`); await wait(800);
          await js(`$('pf-dayStart').value = '08:30'; $('pf-dayStart').dispatchEvent(new Event('change'))`);
          await wait(400);
          await js(`[...document.querySelectorAll('.day-pick')].find(b => b.textContent === 'Sat').click()`);
          await wait(400);
          const prefs = require(path.join(SRC, 'prefs.js'));
          const p = prefs.get('userProfile');
          eq(p.dayStart, '08:30');
          ok(p.workDays.includes(6), 'Saturday added');
          ok((await js(`$('s-usage').textContent`)).includes('This month'), 'cost line shown');
          await js(`$('sp-content').scrollTop = $('sec-assistant').offsetTop + 520`); await wait(300);
          await shot('settings-about-you.png');
          await js(`closeSettings()`);
        });

        await test('old sign-in without Tasks shows "Connect Google Tasks"', async () => {
          tasksConnected = false;
          await js(`setView('week'); loadEvents()`); await wait(1200);
          eq(await js(`!$('tt-connect').hidden && !$('btn-connect-tasks').hidden`), true);
          await js(`$('btn-connect-tasks').click()`); await wait(1200);
          eq(await js(`$('tt-connect').hidden`), true, 'connected after clicking');
          await js(`setView('week')`); await wait(800);
          await shot('sidebar-tasks.png');
        });

        // Runs on whichever system the tests run on (CI runs them on Windows and macOS).
        await test(`fits the platform (${process.platform})`, async () => {
          const mac = process.platform === 'darwin';
          eq(await js(`document.documentElement.classList.contains('mac')`), mac, 'html.mac');
          const pad = await js(`getComputedStyle($('titlebar')).paddingLeft`);
          eq(pad, mac ? '80px' : '14px', 'room for the traffic lights only on a Mac');
          const startup = await js(`$('s-startup').closest('.srow').querySelector('.srow-title').textContent`);
          eq(startup, mac ? 'Open at login' : 'Start with Windows');
          eq(await js(`prettyAccel('CommandOrControl+Alt+K')`), mac ? 'Cmd+Option+K' : 'Ctrl+Alt+K');
          const background = require(path.join(SRC, 'background.js'));
          eq(background.pretty('CommandOrControl+Shift+Space'), mac ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space');
          if (mac) {
            const { Menu } = require('electron');
            const labels = Menu.getApplicationMenu().items.map((i) => i.label);
            eq(labels.slice(0, 3), ['Desk Calendar', 'File', 'Edit'], 'Mac menu bar');
            const file = Menu.getApplicationMenu().items[1].submenu.items.map((i) => i.label);
            ok(file.includes('New Event'), 'File → New Event');
            // The shortcut recorder takes Cmd (metaKey) on a Mac.
            await js(`$('s-hotkey').focus(); $('s-hotkey').dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, altKey: true, bubbles: true }))`);
            await wait(800);
            eq(await js(`$('s-hotkey').value`), 'Cmd+Option+K', 'recorded Cmd+Option+K');
          }
          // Hiding and bringing the window back (red button / Dock click on a Mac, × / tray on Windows).
          w.close(); await wait(300);
          eq(w.isVisible(), false, 'close hides');
          app.emit('activate'); await wait(300);
          eq(w.isVisible(), true, 'Dock click / activate shows it again');
        });

        resolve();
      });
    });
    require(path.join(SRC, 'main.js'));
  });
}

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  // A first-run prefs file: Desk Calendar shouldn't try to start with Windows during tests.
  fs.writeFileSync(path.join(userData, 'prefs.json'), JSON.stringify({ startWithWindows: false, hotkey: 'CommandOrControl+Alt+F9', view: 'week' }));
  await assistantTests(base);
  await uiTests();
  const failed = results.filter(([pass]) => !pass).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  server.close();
  app.exit(failed ? 1 : 0);
});
