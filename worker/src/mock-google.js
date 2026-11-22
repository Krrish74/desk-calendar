// mock-google.js: a FAKE Google Calendar for local testing (npm run dev:mock).
//
// It answers the same REST paths google.js calls, from sample data kept in memory,
// so the whole app (UI, quick add, assistant, delete/undo) can be exercised without
// touching your real calendar or even having Google credentials yet.
// Only used when MOCK_GOOGLE=1, which index.js refuses anywhere but localhost.
// The data resets whenever `wrangler dev` restarts or reloads the code.

import { zonedToUtc, zonedParts, addDaysYmd } from './tz.js';

const SAMPLE_TZ = 'America/New_York'; // sample events are laid out in this zone

class MockError extends Error {
  constructor(status, message) { super(message); this.googleStatus = status; }
}

let store = null; // { calendars: [...], events: Map<calendarId, Map<eventId, event>> }

function seed(email) {
  const cals = [
    { id: email, summary: email, primary: true, accessRole: 'owner', backgroundColor: '#7aa2ff', selected: true,
      defaultReminders: [{ method: 'popup', minutes: 10 }] },
    { id: 'work.sample@group.calendar.google.com', summary: 'Work', accessRole: 'owner', backgroundColor: '#33b679', selected: true, defaultReminders: [] },
    { id: 'fitness.sample@group.calendar.google.com', summary: 'Fitness', accessRole: 'owner', backgroundColor: '#f4511e', selected: true, defaultReminders: [] },
    { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States', accessRole: 'reader', backgroundColor: '#0b8043', selected: true, defaultReminders: [] },
    { id: 'side.sample@group.calendar.google.com', summary: 'Side project', accessRole: 'owner', backgroundColor: '#8e24aa', selected: false, defaultReminders: [] },
  ];
  const events = new Map(cals.map((c) => [c.id, new Map()]));

  // Sample events around "today" (in SAMPLE_TZ).
  const p = zonedParts(new Date(), SAMPLE_TZ);
  const today = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const at = (dayOffset, hour, minute = 0) => {
    const [y, m, d] = addDaysYmd(today, dayOffset).split('-').map(Number);
    return zonedToUtc({ year: y, month: m, day: d, hour, minute }, SAMPLE_TZ).toISOString();
  };
  const soon = new Date(Math.ceil((Date.now() + 25 * 60e3) / 300e3) * 300e3); // ~25 min from now, on a 5-min mark
  const add = (calId, ev) => {
    const id = ev.id || `sample${events.get(calId).size + 1}${calId.length}`;
    events.get(calId).set(id, { kind: 'calendar#event', status: 'confirmed', id, htmlLink: `https://calendar.google.com/event?eid=${id}`, ...ev });
  };
  const timed = (start, end) => ({ start: { dateTime: start, timeZone: SAMPLE_TZ }, end: { dateTime: end, timeZone: SAMPLE_TZ } });
  const allDay = (first, lastInclusive) => ({ start: { date: addDaysYmd(today, first) }, end: { date: addDaysYmd(today, lastInclusive + 1) } });

  add(email, { summary: 'Coffee with Sam', location: 'Blue Bottle', ...timed(at(0, 8, 30), at(0, 9, 15)) });
  add('work.sample@group.calendar.google.com', {
    summary: 'Design review', ...timed(soon.toISOString(), new Date(soon.getTime() + 45 * 60e3).toISOString()),
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] },
  });
  add('work.sample@group.calendar.google.com', { summary: 'Team standup', ...timed(at(1, 9), at(1, 9, 15)), reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] } });
  add('work.sample@group.calendar.google.com', { summary: 'Client call', description: 'Join: https://zoom.us/j/123456789', ...timed(at(1, 14), at(1, 15)), colorId: '5' });
  add('fitness.sample@group.calendar.google.com', { summary: 'Gym', ...timed(at(0, 18), at(0, 19)) });
  add('fitness.sample@group.calendar.google.com', { summary: 'Long run', ...timed(at(2, 7), at(2, 8, 30)) });
  add(email, { summary: "Mom's birthday", ...allDay(3, 3) });
  add(email, { summary: 'Weekend trip', ...allDay(5, 7), colorId: '7' });
  add(email, { summary: 'Declined meeting', ...timed(at(1, 11), at(1, 12)), attendees: [{ email, self: true, responseStatus: 'declined' }] });
  add('en.usa#holiday@group.v.calendar.google.com', { summary: 'Sample Holiday', ...allDay(4, 4) });
  add('side.sample@group.calendar.google.com', { summary: 'Hidden calendar event', ...timed(at(0, 20), at(0, 21)) });

  store = { calendars: cals, events };
}

/** Start/end of an event as instants, for range filtering. */
function bounds(ev) {
  const t = (x) => (x.dateTime ? new Date(x.dateTime) : zonedToUtc({ ...ymdParts(x.date) }, SAMPLE_TZ));
  return [t(ev.start), t(ev.end)];
}
const ymdParts = (s) => { const [year, month, day] = s.split('-').map(Number); return { year, month, day }; };

function calendarOr404(id) {
  const cal = store.calendars.find((c) => c.id === id || (id === 'primary' && c.primary));
  if (!cal) throw new MockError(404, 'Not Found');
  return cal;
}

function writable(cal) {
  if (cal.accessRole !== 'owner' && cal.accessRole !== 'writer') throw new MockError(403, 'Forbidden');
}

function applyPatch(ev, body) {
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === 'conferenceData') {
      if (v === null) { delete ev.conferenceData; delete ev.hangoutLink; } else if (v.createRequest) {
        const code = Math.random().toString(36).slice(2, 5) + '-' + Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 5);
        ev.hangoutLink = `https://meet.google.com/${code}`;
        ev.conferenceData = { conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: ev.hangoutLink }] };
      }
    } else if (v === null) {
      delete ev[k];
    } else {
      ev[k] = v;
    }
  }
  return ev;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// --- Google Tasks (fake) -------------------------------------------------------------------

const TASKS_PREFIX = 'https://tasks.googleapis.com/tasks/v1';

function seedTasks() {
  const p = zonedParts(new Date(), SAMPLE_TZ);
  const today = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const due = (n) => `${addDaysYmd(today, n)}T00:00:00.000Z`;
  const lists = [{ id: 'list-main', title: 'My Tasks' }, { id: 'list-work', title: 'Work tasks' }];
  const tasks = new Map(lists.map((l) => [l.id, new Map()]));
  let n = 0;
  const add = (listId, t) => {
    const id = `task${++n}`;
    tasks.get(listId).set(id, { kind: 'tasks#task', id, status: 'needsAction', webViewLink: `https://tasks.google.com/task/${id}`, ...t });
  };
  add('list-main', { title: 'Pay rent', due: due(-2) });
  add('list-main', { title: 'Call mom', due: due(0) });
  add('list-main', { title: 'Buy groceries', due: due(0), status: 'completed', completed: new Date().toISOString() });
  add('list-main', { title: 'Book dentist' });
  add('list-main', { title: 'Renew passport', due: due(3), notes: 'Photos first' });
  add('list-work', { title: 'Review pull request', due: due(-1) });
  add('list-work', { title: 'Write Q4 report', due: due(2), notes: 'About 4 hours of work' });
  add('list-work', { title: 'Plan team offsite' });
  store.taskLists = lists;
  store.tasks = tasks;
}

const truthy = (v) => v !== false && String(v) !== 'false';

function mockTasks(path, { method, query = {}, body }) {
  if (!store.tasks) seedTasks();
  const rest = path.slice(TASKS_PREFIX.length);
  if (rest === '/users/@me/lists' && method === 'GET') return { items: clone(store.taskLists) };

  const m = rest.match(/^\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
  if (!m) throw new MockError(404, `Mock has no route for ${method} ${rest}`);
  let listId = decodeURIComponent(m[1]);
  if (listId === '@default') listId = store.taskLists[0].id;
  const list = store.tasks.get(listId);
  if (!list) throw new MockError(404, 'Task list not found');
  const taskId = m[2] && decodeURIComponent(m[2]);

  if (!taskId && method === 'GET') {
    const items = [...list.values()].filter((t) => {
      if (t.status === 'completed' && !truthy(query.showCompleted ?? true)) return false;
      if (query.dueMin && (!t.due || t.due < query.dueMin)) return false;
      if (query.dueMax && (!t.due || t.due >= query.dueMax)) return false;
      return true;
    });
    return { items: clone(items) };
  }
  if (!taskId && method === 'POST') {
    const id = `task${crypto.randomUUID().slice(0, 8)}`;
    const t = { kind: 'tasks#task', id, status: 'needsAction', webViewLink: `https://tasks.google.com/task/${id}` };
    for (const [k, v] of Object.entries(body || {})) if (v !== undefined && v !== null) t[k] = v;
    list.set(id, t);
    return clone(t);
  }
  const t = list.get(taskId);
  if (!t) throw new MockError(404, 'Task not found');
  if (method === 'GET') return clone(t);
  if (method === 'PATCH') {
    for (const [k, v] of Object.entries(body || {})) { if (v === null) delete t[k]; else t[k] = v; }
    if (t.status === 'completed' && !t.completed) t.completed = new Date().toISOString();
    return clone(t);
  }
  if (method === 'DELETE') { list.delete(taskId); return null; }
  throw new MockError(405, 'Method not allowed');
}

export async function mockGoogle(email, path, { method, query = {}, body }) {
  if (!store) seed(email);
  await new Promise((r) => setTimeout(r, 40)); // a little latency, like the real thing
  if (path.startsWith(TASKS_PREFIX)) return mockTasks(path, { method, query, body });

  if (path === '/users/me/calendarList' && method === 'GET') {
    return { items: clone(store.calendars) };
  }

  const m = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (!m) throw new MockError(404, `Mock has no route for ${method} ${path}`);
  const cal = calendarOr404(decodeURIComponent(m[1]));
  const eventId = m[2] && decodeURIComponent(m[2]);
  const events = store.events.get(cal.id);

  if (!eventId && method === 'GET') {
    const min = query.timeMin ? new Date(query.timeMin) : new Date(0);
    const max = query.timeMax ? new Date(query.timeMax) : new Date(8.64e15);
    const items = [...events.values()]
      .filter((ev) => { const [s, e] = bounds(ev); return s < max && e > min; })
      .sort((a, b) => bounds(a)[0] - bounds(b)[0]);
    return { items: clone(items) };
  }
  if (!eventId && method === 'POST') {
    writable(cal);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const ev = applyPatch({ kind: 'calendar#event', status: 'confirmed', id, htmlLink: `https://calendar.google.com/event?eid=${id}` }, body);
    if (!ev.reminders) ev.reminders = { useDefault: true };
    events.set(id, ev);
    return clone(ev);
  }

  const ev = events.get(eventId);
  if (!ev) throw new MockError(404, 'Not Found');
  if (method === 'GET') return clone(ev);
  writable(cal);
  if (method === 'PATCH') return clone(applyPatch(ev, body));
  if (method === 'DELETE') { events.delete(eventId); return null; }
  throw new MockError(405, 'Method not allowed');
}

export { MockError };
