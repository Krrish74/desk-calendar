// tasks.js: Google Tasks on the phone (ported from the desktop's src/renderer/js/tasks.js).
//
// What shows where:
//   • Agenda, top: "Today's tasks": tasks due today plus unfinished ones from earlier days
//     (marked "Overdue"), a checkbox each, and an "Add a task" box that understands dates
//     ("call mom friday" is due Friday; no date means today). Ticked-off tasks move into a
//     "Show done" list.
//   • Agenda, each later day: its tasks above its events.
//   • Tap a task: details sheet (mark done/undo, edit, delete with Undo, Google Tasks,
//     "Schedule with assistant", which opens the assistant with a request filled in).
//
// Tasks are date-only (Google's API has no task times), so they never appear in the Day /
// 3-day hour grids or Month, and the event drag/edit code never sees them.

import { el, icon, button, ymd, fromYmd, isToday, fmtDay, openUrl } from './util.js';
import { api } from './api.js';
import { state, emit, status } from './state.js';
import { openSheet, closeSheet, showToast } from './sheet.js';

const TASK_FADE_MS = 600; // a ticked task lingers this long before moving to "Done"

state.tasks = [];              // tasks in the Agenda's range (plus overdue ones)
state.tasksStatus = 'loading'; // loading | ok | needs-connect | api-disabled | error
state.tasksError = '';
state.taskLists = [];
let showDone = false;
let seq = 0;

// --- Loading ---------------------------------------------------------------------------

/** Load tasks for the Agenda's days (others views don't show tasks). */
export async function loadTasks(range) {
  if (state.view !== 'agenda') return;
  const mine = ++seq;
  try {
    const list = await api.tasks({ from: ymd(range.start), to: ymd(range.end), overdue: true, completed: true });
    if (mine !== seq) return;
    state.tasks = list;
    state.tasksStatus = 'ok';
    if (!state.taskLists.length) api.taskLists().then((l) => { state.taskLists = l; }).catch(() => {});
  } catch (err) {
    if (mine !== seq) return;
    state.tasksStatus = err.code === 'TASKS_SCOPE' ? 'needs-connect' : err.code === 'TASKS_API_DISABLED' ? 'api-disabled' : 'error';
    state.tasksError = err.message;
  }
  emit('render');
}

const todayKey = () => ymd(new Date());
/** Tasks for "Today's tasks": due today, plus unfinished overdue ones. */
export const todayTasks = () => state.tasks.filter((t) => t.due === todayKey() || t.overdue);
/** Tasks listed on a later day in the Agenda. */
export const tasksForDay = (d) => state.tasks.filter((t) => t.due === ymd(d) && !t.overdue);

// --- One task row ------------------------------------------------------------------------

const dueDate = (t) => (t.due ? fromYmd(t.due) : null);

/** "Overdue · Mon" for an overdue task, '' otherwise. */
function overdueLabel(t) {
  if (!t.overdue) return '';
  const d = dueDate(t);
  const days = Math.round((fromYmd(todayKey()) - d) / 86400000);
  return days === 1 ? 'Overdue · yesterday' : `Overdue · ${d.toLocaleDateString([], days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' })}`;
}

export function taskRow(t) {
  const row = el('div', `task-row${t.completed ? ' done' : ''}${t.overdue ? ' overdue' : ''}`);
  row.dataset.taskId = t.id;
  const check = button('task-check', [icon(t.completed ? 'checkmark_circle-filled' : 'circle')], (e) => { e.stopPropagation(); toggleTask(t, row); });
  check.setAttribute('aria-label', t.completed ? 'Mark not done' : 'Mark done');
  check.setAttribute('aria-pressed', String(t.completed));
  const text = el('div', 'task-text');
  text.append(el('div', 'task-title', t.title));
  const meta = [overdueLabel(t), state.taskLists.length > 1 ? t.listName : ''].filter(Boolean).join(' · ');
  if (meta) text.append(el('div', 'task-meta', meta));
  row.append(check, text);
  row.onclick = () => openTaskDetails(t);
  return row;
}

// --- "Today's tasks" (top of the Agenda) ------------------------------------------------------

export function todayTasksCard() {
  const card = el('section', 'tt-card');
  const head = el('div', 'tt-head');
  const list = todayTasks();
  const open = [...list.filter((t) => !t.completed && t.overdue), ...list.filter((t) => !t.completed && !t.overdue)];
  const done = list.filter((t) => t.completed);
  head.append(icon('task_list_ltr'), el('h3', '', 'Today\'s tasks'), el('span', 'tt-count', open.length ? String(open.length) : ''));
  card.append(head);

  if (state.tasksStatus === 'needs-connect' || state.tasksStatus === 'api-disabled' || state.tasksStatus === 'error') {
    card.append(el('p', 'tt-problem', state.tasksError));
    // Signing in again adds the Tasks permission; Google keeps the calendar ones.
    if (state.tasksStatus === 'needs-connect') card.append(button('btn primary small', [icon('task_list_ltr'), 'Connect Google Tasks'], () => { location.href = '/auth/login'; }));
    return card;
  }

  card.append(addTaskBox());
  const ul = el('div', 'tt-list');
  for (const t of open) ul.append(taskRow(t));
  if (!open.length && state.tasksStatus === 'ok') ul.append(el('div', 'tt-empty', done.length ? 'All done for today.' : 'Nothing due today.'));
  card.append(ul);
  if (done.length) {
    card.append(button('btn subtle small tt-done-toggle', `${showDone ? 'Hide' : 'Show'} done (${done.length})`, () => { showDone = !showDone; emit('render'); }));
    if (showDone) {
      const doneList = el('div', 'tt-list');
      for (const t of done) doneList.append(taskRow(t));
      card.append(doneList);
    }
  }
  return card;
}

/** "Add a task" with a live preview of the date it understood. */
function addTaskBox() {
  const form = el('form', 'tt-add');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'Add a task (e.g. "call mom friday")';
  input.enterKeyHint = 'done';
  input.autocomplete = 'off';
  const preview = el('div', 'tt-preview');
  preview.hidden = true;
  form.append(input, preview);
  let timer, mine = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const text = input.value.trim();
      const n = ++mine;
      if (!text) { preview.hidden = true; return; }
      try {
        const p = await api.parseTask(text);
        if (n !== mine) return;
        const due = fromYmd(p.due);
        preview.textContent = `${p.title} · ${isToday(due) ? 'today' : `due ${fmtDay(due)}`}`;
        preview.hidden = false;
      } catch { /* preview is only a hint */ }
    }, 250);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      const p = await api.parseTask(text);
      const created = await api.createTask({ title: p.title, due: p.due });
      status(`Added task “${created.title}”${isToday(fromYmd(created.due)) ? '' : ` for ${fmtDay(fromYmd(created.due))}`}`);
      emit('reload');
    } catch (err) {
      status(err.message, true);
      input.disabled = false;
    }
  });
  return form;
}

// --- Changing tasks ----------------------------------------------------------------------------

/** Tick / untick. The row updates at once; Google is told in the background. */
async function toggleTask(t, row) {
  const completed = !t.completed;
  t.completed = completed;
  t.overdue = !completed && !!t.due && t.due < todayKey();
  row?.classList.toggle('done', completed);
  const ico = row?.querySelector('.task-check .ico');
  if (ico) ico.className = `ico ${completed ? 'i-checkmark_circle-filled' : 'i-circle'}`;
  try {
    await api.updateTask({ listId: t.listId, taskId: t.id, completed });
    if (completed) status(`Done: “${t.title}”`);
  } catch (err) {
    t.completed = !completed;
    status(err.message, true);
  }
  setTimeout(() => emit('render'), completed ? TASK_FADE_MS : 0);
}

async function deleteTaskWithUndo(t) {
  let token;
  try {
    ({ token } = await api.deleteTaskLater(t.listId, t.id));
  } catch (err) { status(err.message, true); return; }
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  emit('render');
  showToast('Task deleted', 'Undo', async () => {
    try {
      const { restored } = await api.undoDelete(token);
      status(restored ? `Restored “${t.title}”` : 'Too late to undo: it was already deleted.', !restored);
    } catch (err) { status(err.message, true); }
    emit('reload');
  });
}

// --- Details sheet ---------------------------------------------------------------------------

export function openTaskDetails(t) {
  const body = el('div');
  const head = el('div', 'dt-head');
  const ico = icon(t.completed ? 'checkmark_circle-filled' : 'task_list_ltr');
  ico.classList.add('dt-task-ico');
  const titles = el('div');
  const due = dueDate(t);
  titles.append(
    el('div', `dt-title${t.completed ? ' done' : ''}`, t.title),
    el('div', 'dt-when', due ? `${t.overdue ? 'Overdue · was due' : 'Due'} ${due.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}` : 'No due date'),
  );
  head.append(ico, titles);
  body.append(head);

  const row = (iconName, text) => {
    const r = el('div', 'dt-row');
    r.append(icon(iconName), el('div', 'dt-text', text));
    body.append(r);
  };
  if (t.notes) row('text_description', t.notes);
  row('task_list_ltr', t.listName);

  const main = el('div', 'task-actions');
  main.append(
    button('btn primary block', [icon(t.completed ? 'arrow_undo' : 'checkmark'), t.completed ? 'Mark not done' : 'Mark done'], () => {
      closeSheet();
      toggleTask(t, document.querySelector(`.task-row[data-task-id="${CSS.escape(t.id)}"]`));
    }),
    button('btn block', [icon('calendar_clock'), 'Schedule with assistant'], () => {
      closeSheet(true);
      emit('assistant', `Find time for my task "${t.title}"${t.due ? ` (due ${fmtDay(due)})` : ''}.`);
    }),
  );
  body.append(main);

  const actions = el('div', 'dt-actions');
  actions.append(
    button('btn', [icon('edit'), 'Edit'], () => { closeSheet(true); openTaskEditor(t); }),
    button('btn danger', [icon('delete'), 'Delete'], () => { closeSheet(); deleteTaskWithUndo(t); }),
    button('btn', [icon('open'), 'Google'], () => openUrl(t.webViewLink || 'https://tasks.google.com/')),
  );
  body.append(actions);
  openSheet({ title: '', body });
}

// --- Editor sheet ----------------------------------------------------------------------------

export async function openTaskEditor(t = null) {
  const body = el('div');
  const title = el('input', 'ed-title');
  title.type = 'text';
  title.value = t?.title || '';
  title.placeholder = 'Task title';
  body.append(title);

  const noDate = el('input', 'toggle');
  noDate.type = 'checkbox';
  noDate.checked = !!t && !t.due;
  const dueRow = el('div', 'ed-row');
  dueRow.append(icon('calendar_ltr'), el('span', 'label', 'No due date'), noDate);
  const due = el('input');
  due.type = 'date';
  due.value = t?.due || ymd(new Date());
  const dateRow = el('div', 'ed-row');
  dateRow.style.paddingLeft = '36px';
  dateRow.append(el('span', 'label', 'Due'), due);
  dateRow.querySelector('.label').style.flex = '0 0 52px';
  const sync = () => { dateRow.hidden = noDate.checked; };
  noDate.onchange = sync;
  sync();
  body.append(dueRow, dateRow);

  const list = el('select');
  if (!state.taskLists.length) { try { state.taskLists = await api.taskLists(); } catch { /* shown empty */ } }
  for (const l of state.taskLists) list.append(new Option(l.name, l.id));
  list.value = t?.listId || state.prefs.defaultTaskListId || state.taskLists[0]?.id || '';
  list.disabled = !!t; // moving a task between lists isn't supported by Google's API
  const listRow = el('div', 'ed-row');
  listRow.append(icon('task_list_ltr'), list);
  body.append(listRow);

  const notes = el('textarea');
  notes.rows = 4;
  notes.placeholder = 'Add notes';
  notes.value = t?.notes || '';
  const notesRow = el('div', 'ed-row top');
  notesRow.append(icon('text_description'), notes);
  body.append(notesRow);

  if (t) body.append(button('btn danger block ed-delete', [icon('delete'), 'Delete task'], () => { closeSheet(); deleteTaskWithUndo(t); }));

  const save = button('btn primary small', 'Save', async () => {
    const fields = { title: title.value.trim(), notes: notes.value, due: noDate.checked ? null : (due.value || null) };
    if (!fields.title) { status('Give the task a title.', true); return; }
    save.disabled = true;
    try {
      if (t) await api.updateTask({ listId: t.listId, taskId: t.id, ...fields });
      else await api.createTask({ ...fields, listId: list.value || undefined });
      closeSheet();
      status(t ? 'Task saved' : `Added task “${fields.title}”`);
      emit('reload');
    } catch (err) {
      status(err.message, true);
      save.disabled = false;
    }
  });
  openSheet({ title: t ? 'Edit task' : 'New task', body, full: true, actions: [save] });
  if (!t) title.focus({ preventScroll: true });
}

export const resetTasksView = () => { showDone = false; };
