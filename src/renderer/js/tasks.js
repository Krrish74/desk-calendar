// tasks.js: Google Tasks in the sidebar ("Today's tasks") and the Agenda view.
//
// What shows where:
//   • Sidebar: tasks due today plus unfinished tasks from earlier days ("Overdue"),
//     with a checkbox each and an "Add a task" box that understands dates
//     ("call mom friday" is due Friday; no date means today). Ticked-off tasks
//     move into a collapsible "Done" list.
//   • Agenda: each day lists its tasks above its events; today also gets the overdue ones.
//   • Click a task for details: done/undo, edit, schedule with the assistant, delete (with Undo).
//
// Tasks are date-only (Google's API has no task times), so they never go in the hour grid.

const TASK_FADE_MS = 600; // a ticked task lingers this long before moving to "Done"

state.tasks = [];        // tasks due in the visible range (Agenda only)
state.todayTasks = [];   // due today + overdue, for the sidebar
state.tasksStatus = 'loading'; // loading | ok | needs-connect | api-disabled | error
state.tasksError = '';
state.taskLists = [];
let showDoneTasks = false;
let taskSeq = 0;

// --- Loading ---------------------------------------------------------------

async function loadTasks() {
  const seq = ++taskSeq;
  const today = startOfDay(new Date());
  const range = viewRange();
  const forAgenda = state.view === 'agenda';
  const [todayRes, viewRes] = await Promise.all([
    desk.getTasks({ fromISO: today.toISOString(), toISO: addDays(today, 1).toISOString(), includeOverdue: true, includeCompleted: true }),
    forAgenda ? desk.getTasks({ fromISO: range.start.toISOString(), toISO: range.end.toISOString(), includeCompleted: true }) : null,
  ]);
  if (seq !== taskSeq) return;

  const problem = [todayRes, viewRes].find((r) => r && r.error);
  if (problem) {
    state.tasksStatus = problem.code === 'TASKS_SCOPE' ? 'needs-connect'
      : problem.code === 'TASKS_API_DISABLED' ? 'api-disabled' : 'error';
    state.tasksError = problem.error;
    if (problem.code === 'NOT_SIGNED_IN') { showSetup(problem.error); return; }
  } else {
    state.tasksStatus = 'ok';
    state.todayTasks = todayRes.data;
    state.tasks = viewRes ? viewRes.data : [];
  }
  renderTodayTasks();
  if (forAgenda) renderView();
}

// --- One task row (sidebar and Agenda) ----------------------------------------

/** "Overdue · Mon" for an overdue task, '' otherwise. */
function overdueLabel(t) {
  if (!t.overdue) return '';
  const d = dueDate(t);
  const days = Math.round((startOfDay(new Date()) - d) / 86400000);
  return days === 1 ? 'Overdue · yesterday' : `Overdue · ${d.toLocaleDateString([], days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' })}`;
}

/** Local Date for a task's due 'YYYY-MM-DD' (or null). */
function dueDate(t) {
  if (!t.due) return null;
  const [y, m, d] = t.due.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function taskRow(t, { showList = false } = {}) {
  const row = el('div', `task-row${t.completed ? ' done' : ''}${t.overdue ? ' overdue' : ''}`);
  row.dataset.taskId = t.id;

  const check = el('button', 'task-check');
  check.type = 'button';
  check.title = t.completed ? 'Mark not done' : 'Mark done';
  check.setAttribute('aria-pressed', String(t.completed));
  check.append(icon(t.completed ? 'checkmark_circle-filled' : 'circle'));
  check.onclick = (e) => { e.stopPropagation(); toggleTask(t, row); };

  const text = el('button', 'task-text');
  text.type = 'button';
  text.append(el('span', 'task-title', t.title));
  const meta = [overdueLabel(t), showList ? t.listName : ''].filter(Boolean).join(' · ');
  if (meta) text.append(el('span', 'task-meta', meta));
  text.onclick = () => openTaskDetails(t, row);

  row.append(check, text);
  return row;
}

// --- Sidebar ---------------------------------------------------------------

function renderTodayTasks() {
  const box = $('today-tasks');
  const connect = $('tt-connect');
  const open = state.todayTasks.filter((t) => !t.completed);
  const done = state.todayTasks.filter((t) => t.completed);
  const problem = state.tasksStatus !== 'ok' && state.tasksStatus !== 'loading';

  connect.hidden = !problem;
  $('tt-add').hidden = problem;
  if (problem) {
    $('tt-connect-msg').textContent = state.tasksError;
    $('btn-connect-tasks').hidden = state.tasksStatus !== 'needs-connect';
  }
  box.classList.toggle('empty', !problem && !open.length);

  $('tt-count').textContent = open.length ? String(open.length) : '';
  // Overdue first (oldest first), then today's in Google's order.
  const ordered = [...open.filter((t) => t.overdue), ...open.filter((t) => !t.overdue)];
  $('tt-list').replaceChildren(...ordered.map((t) => {
    const li = el('li');
    li.append(taskRow(t));
    return li;
  }));
  if (!problem && !open.length && state.tasksStatus === 'ok') {
    $('tt-list').append(el('li', 'tt-empty', done.length ? 'All done for today.' : 'Nothing due today.'));
  }

  $('tt-done-toggle').hidden = !done.length;
  $('tt-done-toggle').textContent = `${showDoneTasks ? 'Hide' : 'Show'} done (${done.length})`;
  $('tt-done').hidden = !showDoneTasks || !done.length;
  $('tt-done').replaceChildren(...done.map((t) => {
    const li = el('li');
    li.append(taskRow(t));
    return li;
  }));
}

$('tt-done-toggle').onclick = () => { showDoneTasks = !showDoneTasks; renderTodayTasks(); };

$('btn-connect-tasks').onclick = async () => {
  status('Finish connecting Google Tasks in your browser…');
  try {
    unwrap(await desk.connectTasks());
    status('Google Tasks connected.');
    loadTasks();
  } catch (e) { status(e.message, true); }
};

// "Add a task": live preview of the parsed date, Enter to add.
let taskPreviewTimer;
$('tt-input').addEventListener('input', () => {
  clearTimeout(taskPreviewTimer);
  taskPreviewTimer = setTimeout(updateTaskPreview, 150);
});

async function updateTaskPreview() {
  const text = $('tt-input').value.trim();
  if (!text) { $('tt-preview').hidden = true; return; }
  const p = (await desk.parseTask(text)).data;
  if (!p) return;
  const due = dueDate(p);
  $('tt-preview').textContent = `↵ ${p.title} · ${isToday(due) ? 'today' : `due ${fmtDay(due)}`}`;
  $('tt-preview').hidden = false;
}

let taskAddBusy = false;
$('tt-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('tt-input').value.trim();
  // Enter twice before Google answers would add the task twice.
  if (!text || taskAddBusy) return;
  taskAddBusy = true;
  $('tt-input').readOnly = true;
  try {
    const p = unwrap(await desk.parseTask(text));
    const created = unwrap(await desk.createTask({ title: p.title, due: p.due }));
    $('tt-input').value = '';
    $('tt-preview').hidden = true;
    status(`Added task “${created.title}”${isToday(dueDate(created)) ? '' : ` for ${fmtDay(dueDate(created))}`}`);
    loadTasks();
  } catch (err) {
    status(err.message, true);
  } finally {
    taskAddBusy = false;
    $('tt-input').readOnly = false;
  }
});

// --- Changing tasks ----------------------------------------------------------

/** Tick / untick. The row updates at once; Google is told in the background. */
async function toggleTask(t, row) {
  const completed = !t.completed;
  const all = [state.todayTasks, state.tasks].flatMap((list) => list.filter((x) => x.id === t.id));
  for (const x of all) { x.completed = completed; x.overdue = !completed && !!x.due && x.due < ymd(new Date()); }
  row.classList.toggle('done', completed);
  row.querySelector('.task-check .ico').className = `ico ${completed ? 'i-checkmark_circle-filled' : 'i-circle'}`;
  try {
    unwrap(await desk.updateTask({ listId: t.listId, taskId: t.id, completed }));
    if (completed) status(`Done: “${t.title}”`);
  } catch (err) {
    for (const x of all) x.completed = !completed;
    status(err.message, true);
  }
  setTimeout(() => { renderTodayTasks(); if (state.view === 'agenda') renderView(); }, completed ? TASK_FADE_MS : 0);
}

async function deleteTaskWithUndo(t) {
  let token;
  try {
    token = unwrap(await desk.deleteTaskLater({ listId: t.listId, taskId: t.id, title: t.title }));
  } catch (err) { status(err.message, true); return; }
  state.todayTasks = state.todayTasks.filter((x) => x.id !== t.id);
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  renderTodayTasks();
  if (state.view === 'agenda') renderView();
  showToast('Task deleted', 'Undo', async () => {
    try {
      const undone = unwrap(await desk.undoDelete(token));
      status(undone ? `Restored “${t.title}”` : 'Too late to undo: it was already deleted.', !undone);
    } catch (err) { status(err.message, true); }
    loadTasks();
  });
}

// --- Details popover -----------------------------------------------------------

function openTaskDetails(t, anchorEl) {
  const pop = el('div', 'details task-details');

  const bar = el('div', 'dt-actions');
  const action = (iconName, title, fn) => {
    const b = el('button', 'icon');
    b.type = 'button';
    b.title = title;
    b.append(icon(iconName));
    b.onclick = fn;
    bar.append(b);
  };
  action('edit', 'Edit', () => { closePopover(); openTaskEditor(t); });
  action('delete', 'Delete', () => { closePopover(); deleteTaskWithUndo(t); });
  if (t.webViewLink) action('open', 'Open in Google Tasks', () => desk.openUrl(t.webViewLink));
  action('dismiss', 'Close', closePopover);
  pop.append(bar);

  const head = el('div', 'dt-head');
  head.append(icon(t.completed ? 'checkmark_circle-filled' : 'task_list_ltr'));
  head.firstChild.classList.add('dt-task-ico');
  const titles = el('div');
  const due = dueDate(t);
  titles.append(
    el('div', 'dt-title', t.title),
    el('div', 'dt-when', due ? `${t.overdue ? 'Overdue · was due' : 'Due'} ${due.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}` : 'No due date'),
  );
  head.append(titles);
  pop.append(head);

  if (t.notes) {
    const row = el('div', 'dt-row dt-desc');
    const i = icon('text_description');
    i.classList.add('dt-ico');
    row.append(i, el('div', 'dt-text', t.notes));
    pop.append(row);
  }
  const listRow = el('div', 'dt-row');
  const li = icon('task_list_ltr');
  li.classList.add('dt-ico');
  listRow.append(li, el('div', 'dt-text', t.listName));
  pop.append(listRow);

  const buttons = el('div', 'dt-buttons');
  const doneBtn = el('button', 'btn', t.completed ? 'Mark not done' : 'Mark done');
  doneBtn.type = 'button';
  doneBtn.prepend(icon(t.completed ? 'arrow_undo' : 'checkmark'));
  doneBtn.onclick = () => {
    closePopover();
    const row = document.querySelector(`.task-row[data-task-id="${CSS.escape(t.id)}"]`) || el('div');
    toggleTask(t, row);
  };
  const plan = el('button', 'btn', 'Schedule with assistant');
  plan.type = 'button';
  plan.prepend(icon('calendar_clock'));
  plan.onclick = () => {
    closePopover();
    toggleChat(true);
    $('chat-input').value = `Find time for my task "${t.title}"${t.due ? ` (due ${fmtDay(due)})` : ''}.`;
    setTimeout(() => $('chat-input').focus(), 220);
  };
  buttons.append(doneBtn, plan);
  pop.append(buttons);

  openPopover(pop, anchorEl, { side: !!anchorEl.closest('#sidebar') });
}

// --- Editor dialog --------------------------------------------------------------

let editingTask = null;

async function openTaskEditor(t = null) {
  editingTask = t;
  $('task-editor-heading').textContent = t ? 'Edit task' : 'New task';
  $('tf-title').value = t?.title || '';
  $('tf-nodate').checked = !!t && !t.due;
  $('tf-due').value = t?.due || ymd(new Date());
  $('tf-due').disabled = $('tf-nodate').checked;
  $('tf-notes').value = t?.notes || '';
  if (!state.taskLists.length) state.taskLists = (await desk.getTaskLists()).data || [];
  $('tf-list').replaceChildren(...state.taskLists.map((l) => new Option(l.name, l.id)));
  $('tf-list').value = t?.listId || state.prefs?.defaultTaskListId || state.taskLists[0]?.id || '';
  $('tf-list').disabled = !!t; // moving a task between lists isn't supported by Google's API
  $('btn-task-delete').hidden = !t;
  $('task-editor').showModal();
  $('tf-title').focus();
}

$('tf-nodate').onchange = () => { $('tf-due').disabled = $('tf-nodate').checked; };
$('btn-task-cancel').onclick = () => $('task-editor').close();
$('btn-task-delete').onclick = () => { $('task-editor').close(); if (editingTask) deleteTaskWithUndo(editingTask); };

let taskEditorSession = 0;
$('task-editor').addEventListener('close', () => { taskEditorSession++; });
$('task-editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('tf-title').value.trim();
  if (!title || $('btn-task-save').disabled) return; // disabled while saving: no duplicates
  const fields = { title, notes: $('tf-notes').value, due: $('tf-nodate').checked ? null : $('tf-due').value || null };
  // This save belongs to the task open now, even if the dialog changes before Google answers.
  const target = editingTask;
  const session = taskEditorSession;
  const errorBox = $('task-editor-error');
  errorBox.hidden = true;
  $('btn-task-save').disabled = true;
  try {
    if (target) unwrap(await desk.updateTask({ listId: target.listId, taskId: target.id, ...fields }));
    else unwrap(await desk.createTask({ ...fields, listId: $('tf-list').value || undefined }));
    if (session === taskEditorSession) $('task-editor').close();
    status(target ? 'Task saved' : `Added task “${title}”`);
    loadTasks();
  } catch (err) {
    if (session === taskEditorSession && $('task-editor').open) { errorBox.textContent = err.message; errorBox.hidden = false; }
    else status(err.message, true);
  } finally {
    $('btn-task-save').disabled = false;
  }
});

// --- Agenda ----------------------------------------------------------------------

/** Tasks to show on day `d` in the Agenda (today also gets the overdue ones). */
function agendaTasksFor(d) {
  const key = ymd(d);
  const list = state.tasks.filter((t) => t.due === key && !t.overdue);
  if (isToday(d)) {
    const seen = new Set(list.map((t) => t.id));
    for (const t of state.todayTasks) if ((t.overdue || t.due === key) && !seen.has(t.id)) list.unshift(t);
  }
  return list;
}

function agendaTaskList(list) {
  const box = el('div', 'ag-tasks');
  for (const t of list) box.append(taskRow(t, { showList: state.taskLists.length > 1 }));
  return box;
}
