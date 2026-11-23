// tasks.js: Google Tasks (the "Tasks" you see in Google Calendar).
//
// Uses the same signed-in Google client as calendar.js, with the extra
// `https://www.googleapis.com/auth/tasks` permission (see auth.js SCOPES).
//
// Good to know about the Tasks API:
//   • A task's due value is a DATE only. Google Calendar lets you give a task a time,
//     but the API never exposes it, so here every task is date-only ("due Friday").
//   • Completed tasks are "hidden" by Google's own apps, so we ask for showHidden too.
//   • '@default' is a valid list id meaning "your main list" (usually "My Tasks").
//
// Every task we hand out looks like:
//   { kind: 'task', id, listId, listName, title, notes, due: 'YYYY-MM-DD' | null,
//     completed, overdue, webViewLink }

const { tasks: tasksApi } = require('@googleapis/tasks');
const auth = require('./auth');
const prefs = require('./prefs');

const LIST_CACHE_MS = 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3; // up to 300 tasks per list per query: plenty for a personal list

function api() {
  if (!auth.hasTasksScope()) throw tasksError('TASKS_SCOPE');
  return tasksApi({ version: 'v1', auth: auth.getClient() });
}

/** Errors the UI turns into a helpful prompt instead of a red message. */
function tasksError(code, detail) {
  const text = {
    TASKS_SCOPE: 'Connect Google Tasks to see your tasks (one click, then allow access in your browser).',
    TASKS_API_DISABLED: 'The Google Tasks API is turned off for your Google Cloud project. Turn it on (see SETUP-GOOGLE.md, step 2), then try again.',
  }[code];
  return Object.assign(new Error(detail ? `${text} (${detail})` : text), { code });
}

/** Wrap a Google call so missing permission / disabled API become those codes. */
async function call(fn) {
  try {
    return await fn(api());
  } catch (err) {
    if (err.code === 'TASKS_SCOPE' || err.code === 'NOT_SIGNED_IN') throw err;
    const status = err.response?.status ?? err.status;
    const msg = err.response?.data?.error?.message || err.message || '';
    if (status === 403 && /insufficient.*(scope|permission)/i.test(msg)) throw tasksError('TASKS_SCOPE');
    if (status === 403 && /(has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED)/i.test(msg)) throw tasksError('TASKS_API_DISABLED');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Task lists
// ---------------------------------------------------------------------------

let listCache = null; // { at, lists }

async function listTaskLists({ fresh = false } = {}) {
  if (!fresh && listCache && Date.now() - listCache.at < LIST_CACHE_MS) return withVisibility(listCache.lists);
  const { data } = await call((t) => t.tasklists.list({ maxResults: 100 }));
  const lists = (data.items || []).map((l) => ({ id: l.id, name: l.title || 'Tasks' }));
  listCache = { at: Date.now(), lists };
  return withVisibility(lists);
}

function withVisibility(lists) {
  const vis = prefs.get('taskListVisibility') || {};
  return lists.map((l) => ({ ...l, visible: vis[l.id] !== false }));
}

function setListVisible(id, visible) {
  prefs.set({ taskListVisibility: { ...(prefs.get('taskListVisibility') || {}), [id]: !!visible } });
  return true;
}

// ---------------------------------------------------------------------------
// Reading tasks
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
/** Local calendar date of a Date, as YYYY-MM-DD. */
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Google stores due dates as midnight UTC of that date. */
const dueStamp = (date) => `${date}T00:00:00.000Z`;

function normalize(t, list, today) {
  const due = t.due ? t.due.slice(0, 10) : null;
  const completed = t.status === 'completed';
  return {
    kind: 'task',
    id: t.id,
    listId: list.id,
    listName: list.name,
    title: t.title || '(No title)',
    notes: t.notes || '',
    due,
    completed,
    overdue: !completed && !!due && due < today,
    webViewLink: t.webViewLink || '',
  };
}

async function fetchList(list, params, today) {
  const out = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await call((t) => t.tasks.list({ tasklist: list.id, maxResults: PAGE_SIZE, pageToken, ...params }));
    for (const t of data.items || []) if (!t.deleted) out.push(normalize(t, list, today));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * Tasks from every visible list.
 *   from, to          Dates: tasks due on local days in [from, to)
 *   includeOverdue    also unfinished tasks due before today
 *   includeUndated    also unfinished tasks with no due date
 *   includeCompleted  include ticked-off tasks in the range (default true)
 * Sorted by due date (undated last), then list order.
 */
async function listTasks({ from, to, includeOverdue = false, includeUndated = false, includeCompleted = true } = {}) {
  const lists = (await listTaskLists()).filter((l) => l.visible);
  const today = ymd(new Date());
  const fromDay = from ? ymd(from) : null;
  const toDay = to ? ymd(to) : null; // exclusive

  const perList = await Promise.all(lists.map(async (list) => {
    try {
      const found = [];
      if (fromDay && toDay) {
        const inRange = await fetchList(list, {
          dueMin: dueStamp(fromDay), dueMax: dueStamp(toDay),
          showCompleted: includeCompleted, showHidden: includeCompleted,
        }, today);
        found.push(...inRange.filter((t) => t.due && t.due >= fromDay && t.due < toDay));
      }
      if (includeOverdue) {
        const old = await fetchList(list, { dueMax: dueStamp(today), showCompleted: false }, today);
        found.push(...old.filter((t) => t.overdue && !(fromDay && t.due >= fromDay)));
      }
      if (includeUndated) {
        // The API can't filter "no due date", so read open tasks and keep the undated ones.
        const open = await fetchList(list, { showCompleted: false }, today);
        found.push(...open.filter((t) => !t.due));
      }
      return found;
    } catch (err) {
      // Permission, disabled API or a dead sign-in apply to every list: report them.
      // Anything else (one list's 404, a 500, a network blip) only skips this list.
      if (/^TASKS_|^NOT_SIGNED_IN$/.test(String(err.code)) || /invalid_grant|invalid_rapt/.test(err.message || '')) throw err;
      console.error(`[tasks] list "${list.name}" failed:`, err.message);
      return [];
    }
  }));

  const seen = new Set();
  return perList.flat()
    .filter((t) => (seen.has(t.id) ? false : seen.add(t.id)))
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
}

// ---------------------------------------------------------------------------
// Changing tasks
// ---------------------------------------------------------------------------

const defaultListId = () => prefs.get('defaultTaskListId') || '@default';

async function listFor(listId) {
  const lists = await listTaskLists();
  return lists.find((l) => l.id === listId) || { id: listId, name: lists[0]?.name || 'Tasks' };
}

/** { title, notes?, due?: 'YYYY-MM-DD' | null, listId? } */
async function createTask({ title, notes, due, listId } = {}) {
  if (!title || !String(title).trim()) throw new Error('A task needs a title.');
  const list = await listFor(listId || defaultListId());
  const { data } = await call((t) => t.tasks.insert({
    tasklist: list.id,
    requestBody: { title: String(title).trim(), notes: notes || undefined, due: due ? dueStamp(checkDate(due)) : undefined },
  }));
  return normalize(data, list, ymd(new Date()));
}

/** { listId, taskId, title?, notes?, due?: 'YYYY-MM-DD' | null (null clears it), completed? } */
async function updateTask({ listId, taskId, title, notes, due, completed } = {}) {
  if (!listId || !taskId) throw new Error('Which task? (list id and task id are required)');
  const body = {};
  if (title !== undefined) body.title = String(title).trim() || '(No title)';
  if (notes !== undefined) body.notes = notes;
  if (due !== undefined) body.due = due ? dueStamp(checkDate(due)) : null;
  if (completed !== undefined) Object.assign(body, completed ? { status: 'completed' } : { status: 'needsAction', completed: null });
  const list = await listFor(listId);
  const { data } = await call((t) => t.tasks.patch({ tasklist: list.id, task: taskId, requestBody: body }));
  return normalize(data, list, ymd(new Date()));
}

/** One task, as listTasks returns it (used to show its real title before deleting). */
async function getTask({ listId, taskId }) {
  if (!listId || !taskId) throw new Error('Which task? (list id and task id are required)');
  const list = await listFor(listId);
  const { data } = await call((t) => t.tasks.get({ tasklist: list.id, task: taskId }));
  return normalize(data, list, ymd(new Date()));
}

async function deleteTask({ listId, taskId }) {
  await call((t) => t.tasks.delete({ tasklist: listId, task: taskId }));
  return { deleted: true };
}

function checkDate(s) {
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) throw new Error(`Due date should look like 2026-11-24, got "${s}".`);
  return m[1];
}

/** Forget cached lists (another Google account may sign in next). */
function clearCache() { listCache = null; }

module.exports = { clearCache, listTaskLists, setListVisible, listTasks, getTask, createTask, updateTask, deleteTask, ymd };
