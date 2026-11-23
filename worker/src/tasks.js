// tasks.js: Google Tasks (the "Tasks" you see in Google Calendar). Ported from the
// desktop app's src/main/tasks.js; same rules, REST calls through google.js.
//
// Good to know about the Tasks API:
//   • A task's due value is a DATE only. Google Calendar lets you give a task a time,
//     but the API never exposes it, so here every task is date-only ("due Friday").
//   • Completed tasks are "hidden" by Google's own apps, so we ask for showHidden too.
//   • '@default' is a valid list id meaning "your main list" (usually "My Tasks").
//   • Needs the extra `https://www.googleapis.com/auth/tasks` permission. Sign-ins from
//     before it existed get the TASKS_SCOPE error, which the phone turns into a
//     "Connect Google Tasks" button (it signs in again; Google keeps the rest).
//
// "Today" is the PHONE's today (c.tz), not the server's.
//
// Every task we hand out looks like:
//   { kind: 'task', id, listId, listName, title, notes, due: 'YYYY-MM-DD' | null,
//     completed, overdue, webViewLink }

import { google, enc, TASKS_API } from './google.js';
import { HttpError, badRequest } from './http.js';
import { ymdIn } from './tz.js';
import { setPrefs } from './prefs.js';
import { TASKS_SCOPE } from './auth.js';

const LIST_CACHE_MS = 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3; // up to 300 tasks per list per query: plenty for a personal list

/** Errors the phone turns into a helpful prompt instead of a red message. */
export function tasksError(code, detail) {
  const text = {
    TASKS_SCOPE: 'Connect Google Tasks to see your tasks (sign in again and allow Tasks).',
    TASKS_API_DISABLED: 'The Google Tasks API is turned off for your Google Cloud project. Turn it on (SETUP-IPHONE.md, step 5), then try again.',
  }[code];
  return new HttpError(403, detail ? `${text} (${detail})` : text, code);
}

/** Does this account's Google sign-in include the Tasks permission? */
export async function hasTasksScope(c) {
  const row = await c.env.DB.prepare('SELECT scope FROM accounts WHERE email = ?').bind(c.email).first();
  return (row?.scope || '').split(' ').includes(TASKS_SCOPE);
}

/** A Tasks API call, with missing permission / disabled API turned into those codes. */
async function call(c, path, opts) {
  if (!(await hasTasksScope(c))) throw tasksError('TASKS_SCOPE');
  try {
    return await google(c, TASKS_API + path, opts);
  } catch (err) {
    const msg = err.message || '';
    if (err.googleStatus === 403 && /insufficient.*(scope|permission)/i.test(msg)) throw tasksError('TASKS_SCOPE');
    if (err.googleStatus === 403 && /(has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED)/i.test(msg)) throw tasksError('TASKS_API_DISABLED');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Task lists
// ---------------------------------------------------------------------------

const listCache = new Map(); // email → { at, lists }

export async function listTaskLists(c, { fresh = false } = {}) {
  const cached = listCache.get(c.email);
  if (!fresh && cached && Date.now() - cached.at < LIST_CACHE_MS) return withVisibility(c, cached.lists);
  const data = await call(c, '/users/@me/lists', { query: { maxResults: 100 } });
  const lists = (data.items || []).map((l) => ({ id: l.id, name: l.title || 'Tasks' }));
  listCache.set(c.email, { at: Date.now(), lists });
  return withVisibility(c, lists);
}

function withVisibility(c, lists) {
  const vis = c.prefs.taskListVisibility || {};
  return lists.map((l) => ({ ...l, visible: vis[l.id] !== false }));
}

export async function setListVisible(c, id, visible) {
  c.prefs = await setPrefs(c.env.DB, c.email, { taskListVisibility: { [id]: !!visible } }); // merged in the database
  return true;
}

// ---------------------------------------------------------------------------
// Reading tasks
// ---------------------------------------------------------------------------

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

async function fetchList(c, list, params, today) {
  const out = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await call(c, `/lists/${enc(list.id)}/tasks`, { query: { maxResults: PAGE_SIZE, pageToken, ...params } });
    for (const t of data.items || []) if (!t.deleted) out.push(normalize(t, list, today));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * Tasks from every visible list.
 *   fromDay, toDay    'YYYY-MM-DD': tasks due on days in [fromDay, toDay) (toDay exclusive)
 *   includeOverdue    also unfinished tasks due before today
 *   includeUndated    also unfinished tasks with no due date
 *   includeCompleted  include ticked-off tasks in the range (default true)
 * Sorted by due date (undated last), then list order.
 */
export async function listTasks(c, { fromDay, toDay, includeOverdue = false, includeUndated = false, includeCompleted = true } = {}) {
  const lists = (await listTaskLists(c)).filter((l) => l.visible);
  const today = ymdIn(new Date(), c.tz);

  const perList = await Promise.all(lists.map(async (list) => {
    try {
      const found = [];
      if (fromDay && toDay) {
        const inRange = await fetchList(c, list, {
          dueMin: dueStamp(fromDay), dueMax: dueStamp(toDay),
          showCompleted: includeCompleted, showHidden: includeCompleted,
        }, today);
        found.push(...inRange.filter((t) => t.due && t.due >= fromDay && t.due < toDay));
      }
      if (includeOverdue) {
        const old = await fetchList(c, list, { dueMax: dueStamp(today), showCompleted: false }, today);
        found.push(...old.filter((t) => t.overdue && !(fromDay && t.due >= fromDay)));
      }
      if (includeUndated) {
        // The API can't filter "no due date", so read open tasks and keep the undated ones.
        const open = await fetchList(c, list, { showCompleted: false }, today);
        found.push(...open.filter((t) => !t.due));
      }
      return found;
    } catch (err) {
      // Permission / API / sign-in problems apply to every list: report them. Others skip the list.
      if (err.code && err.code !== 'GOOGLE') throw err;
      console.error(`[tasks] a list failed: ${err.message}`);
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

const defaultListId = (c) => c.prefs.defaultTaskListId || '@default';

async function listFor(c, listId) {
  const lists = await listTaskLists(c);
  // '@default' is Google's name for your main list, which it always lists first. Using the
  // real id keeps new tasks matching the ones listTasks returns.
  if (listId === '@default' && lists[0]) return lists[0];
  return lists.find((l) => l.id === listId) || { id: listId, name: lists[0]?.name || 'Tasks' };
}

/** { title, notes?, due?: 'YYYY-MM-DD' | null, listId? } */
export async function createTask(c, { title, notes, due, listId } = {}) {
  if (!title || !String(title).trim()) throw badRequest('A task needs a title.');
  const list = await listFor(c, listId || defaultListId(c));
  const data = await call(c, `/lists/${enc(list.id)}/tasks`, {
    method: 'POST',
    body: { title: String(title).trim(), notes: notes || undefined, due: due ? dueStamp(checkDate(due)) : undefined },
  });
  return normalize(data, list, ymdIn(new Date(), c.tz));
}

/** { listId, taskId, title?, notes?, due?: 'YYYY-MM-DD' | null (null clears it), completed? } */
export async function updateTask(c, { listId, taskId, title, notes, due, completed } = {}) {
  if (!listId || !taskId) throw badRequest('Which task? (list id and task id are required)');
  const body = {};
  if (title !== undefined) body.title = String(title).trim() || '(No title)';
  if (notes !== undefined) body.notes = notes;
  if (due !== undefined) body.due = due ? dueStamp(checkDate(due)) : null;
  if (completed !== undefined) Object.assign(body, completed ? { status: 'completed' } : { status: 'needsAction', completed: null });
  const list = await listFor(c, listId);
  const data = await call(c, `/lists/${enc(list.id)}/tasks/${enc(taskId)}`, { method: 'PATCH', body });
  return normalize(data, list, ymdIn(new Date(), c.tz));
}

/** One task, as listTasks returns it (used to show its real title before deleting). */
export async function getTask(c, { listId, taskId } = {}) {
  if (!listId || !taskId) throw badRequest('Which task? (list id and task id are required)');
  const list = await listFor(c, listId);
  const data = await call(c, `/lists/${enc(list.id)}/tasks/${enc(taskId)}`);
  return normalize(data, list, ymdIn(new Date(), c.tz));
}

/** Delete for real. 404/410 ("already gone") counts as success. */
export async function deleteTask(c, { listId, taskId }) {
  try {
    await call(c, `/lists/${enc(listId)}/tasks/${enc(taskId)}`, { method: 'DELETE' });
  } catch (err) {
    if (err.googleStatus !== 404 && err.googleStatus !== 410) throw err;
  }
  return { deleted: true };
}

function checkDate(s) {
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) throw badRequest(`Due date should look like 2026-11-24, got "${s}".`);
  return m[1];
}
