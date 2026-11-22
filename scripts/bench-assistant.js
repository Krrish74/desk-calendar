// bench-assistant.js: measure what the assistant really costs, with and without prompt caching.
//
//   npm run bench                 (or: npx electron scripts/bench-assistant.js)
//
// This CALLS THE REAL CLAUDE API and spends real money (a few cents; it stops at
// BUDGET_USD). It uses the Claude key you saved in Desk Calendar (Settings → Assistant),
// or ANTHROPIC_API_KEY if that's set. Your calendar is NOT touched: Google is replaced by
// a made-up week of events and tasks, and your settings live in a throwaway folder.
//
// Each scenario below runs three ways on Claude Haiku 5.5:
//   warm   caching on, messages close together (the cache from the previous message is still alive)
//   cold   caching on, but every conversation starts with an expired cache (a message after a long pause)
//   off    no caching at all, for comparison
// Tokens and cost come from the API's own usage numbers. Results go to the console and docs/COST.md.

const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BUDGET_USD = 0.25;
const MODEL = 'claude-haiku-5-5';
const SRC = path.join(__dirname, '..', 'src', 'main');
const OUT = path.join(__dirname, '..', 'docs', 'COST.md');

// Read the saved key from the dev app's data folder (DESK_DATA overrides, e.g. the installed app's).
app.setPath('userData', process.env.DESK_DATA || path.join(app.getPath('appData'), 'desk-calendar'));

// --- A made-up week ------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date(); today.setHours(0, 0, 0, 0);
// Day 1 = the next Monday (or tomorrow if that's sooner), so "this week" has room to plan.
const monOffset = ((8 - today.getDay()) % 7) || 7;
const at = (dayOffset, h, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, h, m);

const CALS = [
  { id: 'you@example.com', name: 'Personal', color: '#4285f4', primary: true, canEdit: true, visible: true },
  { id: 'k3n9v0d8s7l2q1w5e4r6t7y8u9i0o1p2@group.calendar.google.com', name: 'School', color: '#8e24aa', canEdit: true, visible: true },
  { id: 'z8x7c6v5b4n3m2a1s2d3f4g5h6j7k8l9@group.calendar.google.com', name: 'Work', color: '#0b8043', canEdit: true, visible: true },
  { id: 'en.usa#holiday@group.v.calendar.google.com', name: 'Holidays', color: '#e67c73', canEdit: false, visible: true },
];
let EVENTS = [];
let TASKS = [];
const LIST = { id: 'MDk4NzY1NDMyMTAxMjM0NTY3ODk6MDow', name: 'My Tasks' };

function resetData() {
  const E = [];
  const add = (cal, title, d, h1, m1, h2, m2, extra = {}) => E.push({
    id: `ev${E.length + 1}x${Math.random().toString(36).slice(2, 10)}`, calendarId: CALS[cal].id, calendarName: CALS[cal].name, canEdit: CALS[cal].canEdit,
    title, location: extra.location || '', description: '', allDay: false, start: at(d, h1, m1).toISOString(), end: at(d, h2, m2).toISOString(),
    color: CALS[cal].color, taskLink: '',
  });
  for (let i = 0; i < 5; i++) {
    const d = monOffset + i;
    add(2, 'Standup', d, 9, 0, 9, 15);
    if (i % 2 === 0) add(1, 'Physics lecture', d, 10, 30, 12, 0, { location: 'Hall B' });
    else add(1, 'Calculus recitation', d, 13, 0, 14, 0, { location: 'Room 210' });
  }
  add(0, 'Gym', monOffset, 18, 0, 19, 0); add(0, 'Gym', monOffset + 2, 18, 0, 19, 0); add(0, 'Gym', monOffset + 4, 7, 0, 8, 0);
  add(2, 'Design review', monOffset + 1, 15, 0, 16, 30);
  add(2, '1:1 with manager', monOffset + 3, 11, 0, 11, 30);
  add(0, 'Dentist', monOffset + 3, 15, 30, 16, 30, { location: 'Smile Dental' });
  add(0, 'Dinner with Sam', monOffset + 4, 19, 0, 21, 0);
  add(1, 'Study group', monOffset + 1, 16, 0, 17, 30);
  add(0, 'Farmers market', monOffset + 5, 9, 0, 11, 0);
  add(0, 'Call grandma', 1, 17, 0, 17, 30);
  add(2, 'Team sync', 1, 11, 0, 12, 0);
  E.push({ id: 'hol1', calendarId: CALS[3].id, calendarName: 'Holidays', canEdit: false, title: 'Holiday (sample)', allDay: true,
    start: at(monOffset + 3, 0).toISOString(), end: at(monOffset + 4, 0).toISOString(), color: CALS[3].color, location: '', taskLink: '' });
  EVENTS = E;
  const T = (id, title, due, extra = {}) => ({ kind: 'task', id, listId: LIST.id, listName: LIST.name, title, notes: '', due, completed: false,
    overdue: !!due && due < ymd(today), webViewLink: '', ...extra });
  TASKS = [
    T('tk1lab', 'Finish lab report', ymd(at(-1, 0))),
    T('tk2quiz', 'Study for physics quiz', ymd(at(monOffset + 3, 0)), { notes: 'Chapters 4-6, practice problems' }),
    T('tk3essay', 'Draft history essay', ymd(at(monOffset + 4, 0))),
    T('tk4email', 'Email advisor about internship', ymd(at(monOffset, 0))),
    T('tk5cs', 'CS problem set 7', ymd(at(monOffset + 2, 0))),
    T('tk6read', 'Read chapter 9', null),
    T('tk7trip', 'Plan spring trip', null),
    T('tk8laundry', 'Laundry', ymd(at(0, 0)), { completed: true }),
  ];
}

// --- Stub Google ---------------------------------------------------------------------
const log = [];
function stubGoogle() {
  const calendar = require(path.join(SRC, 'calendar.js'));
  Object.assign(calendar, {
    listCalendars: async () => CALS,
    listEvents: async (from, to) => EVENTS.filter((e) => new Date(e.end) > from && new Date(e.start) < to),
    getEvent: async ({ eventId }) => { const e = EVENTS.find((x) => x.id === eventId); if (!e) throw new Error('Not found'); return { start: { dateTime: e.start }, end: { dateTime: e.end } }; },
    createEvent: async (p) => {
      log.push(['create_event', p.title]);
      const start = new Date(p.start), end = p.end ? new Date(p.end) : new Date(start.getTime() + 3600e3);
      const e = { id: `new${EVENTS.length}`, calendarId: p.calendarId, calendarName: 'Personal', canEdit: true, title: p.title, allDay: false, start: start.toISOString(), end: end.toISOString(), taskLink: p.taskLink || '' };
      EVENTS.push(e);
      return { id: e.id, title: e.title, allDay: false, start: e.start, end: e.end };
    },
    updateEvent: async (p) => {
      log.push(['update_event', p.eventId]);
      const e = EVENTS.find((x) => x.id === p.eventId);
      if (!e) throw new Error('Not found');
      if (p.start) e.start = new Date(p.start).toISOString();
      if (p.end) e.end = new Date(p.end).toISOString();
      if (p.title) e.title = p.title;
      return { id: e.id, title: e.title, allDay: false, start: e.start, end: e.end };
    },
    deleteEvent: async () => ({ deleted: true }),
  });
  const tasks = require(path.join(SRC, 'tasks.js'));
  Object.assign(tasks, {
    listTaskLists: async () => [{ ...LIST, visible: true }],
    listTasks: async ({ from, to, includeOverdue, includeUndated, includeCompleted }) => {
      const f = ymd(from), t = ymd(to);
      return TASKS.filter((x) => (x.due && x.due >= f && x.due < t && (includeCompleted || !x.completed))
        || (includeOverdue && x.overdue && !x.completed) || (includeUndated && !x.due && !x.completed));
    },
    createTask: async (p) => { log.push(['create_task', p.title]); const t = { kind: 'task', id: `tn${TASKS.length}`, listId: LIST.id, listName: LIST.name, title: p.title, notes: p.notes || '', due: p.due || null, completed: false, overdue: false }; TASKS.push(t); return t; },
    updateTask: async (p) => {
      log.push(['update_task', p.taskId, p.completed]);
      const t = TASKS.find((x) => x.id === p.taskId);
      if (!t) throw new Error('Task not found');
      if (p.completed !== undefined) t.completed = p.completed;
      if (p.due !== undefined) t.due = p.due;
      if (p.title !== undefined) t.title = p.title;
      return { ...t };
    },
    deleteTask: async () => ({ deleted: true }),
  });
}

// --- Scenarios: each is a list of user messages in one conversation --------------------
const SCENARIOS = [
  { name: "What's tomorrow?", turns: ["What's on my calendar tomorrow?"] },
  { name: 'Add a task', turns: ['Add a task to buy groceries on Friday'] },
  { name: 'Complete a task', turns: ['I finished the lab report, tick it off'] },
  { name: 'Plan the week, then confirm', turns: ['Plan my tasks for this week into time blocks', 'Yes, add them'], check: 'plan' },
  { name: 'Find and block 2 hours', turns: ['Find me 2 hours for deep work on Friday and block it'] },
  { name: '3-turn follow-up chat', turns: ["What's my busiest day this week?", 'What free time do I have that day?', 'Move my gym session that week to 7pm on Monday'] },
  { name: 'Delete an event', turns: ['Delete my dentist appointment'] },
];

// --- Run -----------------------------------------------------------------------------------
app.whenReady().then(async () => {
  const store = require(path.join(SRC, 'secureStore.js'));
  let key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) { try { key = await store.load('anthropic-key'); } catch { /* none */ } }
  if (!key) {
    console.error('No Claude key found. Save one in Desk Calendar (Settings → Assistant) or set ANTHROPIC_API_KEY.');
    app.exit(1);
    return;
  }
  // From here on, settings live in a throwaway folder; the key is only kept in this process.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bench-')));
  process.env.ANTHROPIC_API_KEY = key;
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  key = null;

  stubGoogle();
  const prefs = require(path.join(SRC, 'prefs.js'));
  const assistant = require(path.join(SRC, 'assistant.js'));
  prefs.set({
    assistantProvider: 'anthropic', assistantModel: MODEL,
    userProfile: { workDays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '18:00', focusTime: 'morning', blockMinutes: 60, maxBlockMinutes: 120, breakMinutes: 15, meetingBuffer: 10, notes: 'Student with a part-time job. I study best before noon and I am useless after 9pm.' },
  });

  const cfg = { p: { kind: 'anthropic' }, model: MODEL };
  let spent = 0;
  const rows = [];
  const ctx = { onChanged: () => {}, queueDelete: () => 1 };

  const PROFILE = prefs.get('userProfile');
  const MODES = [
    { mode: 'warm', caching: true },
    { mode: 'cold', caching: true },
    { mode: 'off', caching: false },
  ];
  for (const { mode, caching } of MODES) {
    assistant.setCaching(caching);
    for (const sc of SCENARIOS) {
      // Cold start: a slightly different profile gives this conversation its own, empty cache.
      prefs.set({ userProfile: mode === 'cold' ? { ...PROFILE, notes: `${PROFILE.notes} (bench ${sc.name})` } : PROFILE });
      if (spent >= BUDGET_USD) { console.log(`Budget of $${BUDGET_USD} reached; stopping.`); break; }
      resetData();
      log.length = 0;
      assistant.reset();
      const row = { scenario: sc.name, mode, messages: 0, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, notes: '' };
      const replies = [];
      for (const [i, text] of sc.turns.entries()) {
        let r;
        try {
          r = await assistant.send(text, ctx);
        } catch (err) {
          row.notes = `error: ${err.message}`;
          break;
        }
        replies.push(r.reply);
        row.messages++;
        row.requests += r.requests;
        for (const k of ['input', 'cacheWrite', 'cacheRead', 'output']) row[k] += r.usage[k];
        row.cost += r.cost;
        spent += r.cost;
        if (sc.check === 'plan' && i === 0) row.notes = log.some(([t]) => t === 'create_event') ? 'created blocks BEFORE confirming' : 'proposed plan first ✓';
      }
      if (sc.check === 'plan') row.notes += `, then created ${log.filter(([t]) => t === 'create_event').length} blocks`;
      rows.push(row);
      console.log(`${mode.padEnd(4)} | ${sc.name.padEnd(28)} | ${row.requests} req | in ${row.input} + write ${row.cacheWrite} + read ${row.cacheRead} | out ${row.output} | $${row.cost.toFixed(5)} ${row.notes}`);
      if (process.env.BENCH_VERBOSE) console.log(replies.map((r) => `    > ${r.replace(/\n/g, '\n      ')}`).join('\n'));
    }
  }

  writeReport(rows, spent);
  console.log(`\nTotal spent: $${spent.toFixed(4)}. Report: ${path.relative(process.cwd(), OUT)}`);
  app.exit(0);

  function writeReport(all, total) {
    const by = (m) => all.filter((r) => r.mode === m);
    const sum = (list, k) => list.reduce((n, r) => n + r[k], 0);
    const cached = by('warm'), cold = by('cold'), uncached = by('off');
    const perMsg = (list) => sum(list, 'cost') / Math.max(1, sum(list, 'messages'));
    const saving = (list) => (uncached.length ? (1 - sum(list, 'cost') / sum(uncached, 'cost')) * 100 : 0);
    const money = (v) => `$${v.toFixed(5)}`;
    const table = (list) => [
      '| Scenario | Messages | API requests | Input (full price) | Cache write | Cache read | Output | Cost |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
      ...list.map((r) => `| ${r.scenario}${r.notes ? ` (${r.notes})` : ''} | ${r.messages} | ${r.requests} | ${r.input.toLocaleString()} | ${r.cacheWrite.toLocaleString()} | ${r.cacheRead.toLocaleString()} | ${r.output.toLocaleString()} | ${money(r.cost)} |`),
      `| **Total** | ${sum(list, 'messages')} | ${sum(list, 'requests')} | ${sum(list, 'input').toLocaleString()} | ${sum(list, 'cacheWrite').toLocaleString()} | ${sum(list, 'cacheRead').toLocaleString()} | ${sum(list, 'output').toLocaleString()} | **${money(sum(list, 'cost'))}** |`,
    ].join('\n');
    // A realistic mix: about half your messages arrive while the cache is warm.
    const mixed = (perMsg(cached) + perMsg(cold)) / 2;
    const month = (n) => `$${(mixed * n * 30).toFixed(2)}`;
    const md = `# What the assistant costs

Measured with \`npm run bench\` (scripts/bench-assistant.js) on ${new Date().toISOString().slice(0, 10)}: real requests to
**Claude Haiku 5.5** (\`${MODEL}\`), against a made-up week of ${EVENTS.length} events and ${TASKS.length} tasks (no real calendar
involved). Each conversation was run three ways: caching on with a **warm** cache (messages close together),
caching on from a **cold** start (the first message after a pause of 5+ minutes, when the cache has expired),
and caching **off** for comparison.
Token counts come from the API's own \`usage\` numbers; cost uses Haiku 5.5 prices ($0.10 per million input tokens,
$0.50 per million output tokens, cache writes 1.25 × input, cache reads $0.01 per million).

## Summary

| | Caching on, warm | Caching on, cold start | Caching off |
|---|---:|---:|---:|
| Average cost per message | **${money(perMsg(cached))}** | ${money(perMsg(cold))} | ${money(perMsg(uncached))} |
| Total for these ${sum(cached, 'messages')} messages | ${money(sum(cached, 'cost'))} | ${money(sum(cold, 'cost'))} | ${money(sum(uncached, 'cost'))} |
| Saving vs. no caching | **${saving(cached).toFixed(0)}%** | ${saving(cold).toFixed(0)}% | |

A message often takes several API requests: the assistant looks things up (events, tasks, free time) before it answers,
and each request re-sends the instructions, tools and conversation so far. Caching is what keeps those repeats cheap.

Even from a cold start, caching helps: the first request of a message writes the cache (25% extra), and the
assistant's follow-up requests in the same message (looking up events, tasks, free time) read it back at a tenth of the price.

**Typical month**, assuming half your messages hit a warm cache (${money(mixed)} per message): 5 messages a day ≈ ${month(5)}, 20 a day ≈ ${month(20)}, 50 a day ≈ ${month(50)}.
Planning a whole week costs more than a quick question (see the table), and Sonnet / Opus cost about 20× / 40× more than Haiku.

## Caching on, warm cache

${table(cached)}

## Caching on, cold start

${table(cold)}

## Caching off (for comparison)

${table(uncached)}

## What keeps it cheap

- **Prompt caching** (src/main/assistant.js, \`runClaude\`): a cache breakpoint on the system prompt covers the tool
  definitions and instructions, and automatic caching moves a second breakpoint along the conversation, so each extra
  request in a message re-reads earlier content at a tenth of the price. The system prompt never contains the current
  time (that goes in your message), so it stays identical and cached until you edit your profile.
- **Your profile is in the prompt, not retrieved** (CAG, not RAG): it's a few hundred tokens and is cached with the rest.
- **\`find_free_time\` does the arithmetic** in the app (src/main/freetime.js) instead of the model reading every event.
- **Compact tool results**: no colors or links, and long Google calendar / task-list ids become \`c1\`, \`l1\`.
- **Bounded conversations**: a chat restarts after 30 idle minutes or 20 messages, so old history isn't re-sent forever.
- **Haiku 5.5 by default** at medium effort.

Settings → Assistant → Cost shows what your own messages have cost this month.
Total spent running this benchmark: ${money(total)}.
`;
    fs.writeFileSync(OUT, md);
  }
});
