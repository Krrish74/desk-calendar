// editor.js: the full event editor dialog (create / edit / delete), with
// color, Google Meet and notification (reminder) settings.

let editing = null;     // the event being edited, or null when creating
let edColor = '';       // chosen colorId ('' = the calendar's color)
let edMeet = null;      // { link, google, action }: action is 'add' | 'remove' | undefined
let edReminders = null; // 'default' or an array of minutes, e.g. [10, 60]

// Google Calendar's 11 event colors (the IDs Google uses, with today's web-UI shades).
const GOOGLE_COLORS = [
  ['7', 'Peacock', '#039be5'], ['9', 'Blueberry', '#3f51b5'], ['1', 'Lavender', '#7986cb'],
  ['3', 'Grape', '#8e24aa'], ['4', 'Flamingo', '#e67c73'], ['11', 'Tomato', '#d50000'],
  ['6', 'Tangerine', '#f4511e'], ['5', 'Banana', '#f6bf26'], ['2', 'Sage', '#33b679'],
  ['10', 'Basil', '#0b8043'], ['8', 'Graphite', '#616161'],
];

// Choices for a notification, in minutes before the event.
const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
function reminderLabel(min) {
  if (min === 0) return 'At time of event';
  if (min % 10080 === 0) return `${min / 10080} week${min > 10080 ? 's' : ''} before`;
  if (min % 1440 === 0) return `${min / 1440} day${min > 1440 ? 's' : ''} before`;
  if (min % 60 === 0) return `${min / 60} hour${min > 60 ? 's' : ''} before`;
  return `${min} minutes before`;
}

/**
 * Open the editor for `ev`, or for a new event when ev is null.
 * `preset` pre-fills a new event: { title, start, end, allDay, calendarId }
 * (used by the quick-create popover's "More options").
 */
function openEditor(ev, preset = {}) {
  closePopover();
  editing = ev;
  const isNew = !ev;
  const readOnly = !isNew && !ev.canEdit;
  $('editor-heading').textContent = isNew ? 'New event' : readOnly ? 'Event' : 'Edit event';
  $('editor-readonly').hidden = !readOnly;

  // Defaults for a new event: the next whole hour, "Default event length" long.
  const src = ev || preset;
  const start = src.start || new Date(Math.ceil(Date.now() / 3600000) * 3600000);
  let end = src.end || new Date(start.getTime() + state.prefs.defaultEventMinutes * 60000);
  // All-day ends are exclusive (midnight after the last day); show the last day instead.
  if (src.allDay) end = addDays(end, -1);

  $('f-title').value = src.untitled ? '' : (src.title || ''); // don't save "(No title)" as a real title
  editorError('');
  $('f-allday').checked = !!src.allDay;
  $('f-sdate').value = ymd(start);
  $('f-stime').value = hm(start);
  $('f-edate').value = ymd(end);
  $('f-etime').value = hm(end);
  $('f-location').value = ev?.location || '';
  $('f-desc').value = ev?.description || '';

  // Calendar picker: only calendars you can write to. Existing events can't change calendar here.
  const sel = $('f-calendar');
  sel.replaceChildren(...state.calendars.filter((c) => c.canEdit || c.id === ev?.calendarId).map((c) => {
    const o = el('option', '', c.name);
    o.value = c.id;
    return o;
  }));
  sel.value = ev ? ev.calendarId : (preset.calendarId || defaultCalendarId());
  sel.disabled = !isNew;

  // Extras
  edColor = ev?.colorId || '';
  edMeet = ev?.meetLink ? { link: ev.meetLink, google: ev.hasGoogleMeet } : null;
  const r = ev?.reminders;
  edReminders = !r || r.useDefault ? 'default' : (r.overrides || []).map((o) => o.minutes);
  renderColors(readOnly);
  renderMeet(readOnly);
  renderReminders(readOnly);

  for (const input of document.querySelectorAll('#editor-form input, #editor-form textarea')) {
    input.disabled = readOnly;
  }
  $('btn-save').hidden = readOnly;
  $('btn-delete').hidden = isNew || readOnly;
  $('btn-open-google').hidden = isNew;
  toggleTimeInputs();
  $('editor').showModal();
  $('editor').querySelector('.ed-body').scrollTop = 0;
}

const calendarById = (id) => state.calendars.find((c) => c.id === id);
const defaultCalendarId = () =>
  (calendarById(state.prefs.defaultCalendarId)?.canEdit && state.prefs.defaultCalendarId)
  || state.calendars.find((c) => c.primary)?.id || 'primary';

// ============================================================================
// Color
// ============================================================================

function renderColors(readOnly) {
  const box = $('f-colors');
  box.replaceChildren();
  const calColor = calendarById($('f-calendar').value)?.color || '#7aa2ff';
  const options = [['', 'Calendar color', calColor], ...GOOGLE_COLORS];
  for (const [id, name, hex] of options) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.title = name;
    b.style.background = hex;
    b.style.color = textOn(hex);
    if (id === '') b.classList.add('default');
    if (id === edColor) { b.classList.add('selected'); b.append(icon('checkmark')); }
    b.disabled = readOnly;
    b.onclick = () => { edColor = id; renderColors(readOnly); };
    box.append(b);
  }
}
$('f-calendar').addEventListener('change', () => { renderColors(false); renderReminders(false); });

// ============================================================================
// Google Meet
// ============================================================================

function renderMeet(readOnly) {
  const box = $('f-meet');
  box.replaceChildren();

  if (edMeet?.link && edMeet.action !== 'remove') {
    const link = el('a', 'meet-link', edMeet.link.replace(/^https:\/\//, ''));
    link.href = '#';
    link.onclick = (e) => { e.preventDefault(); desk.openUrl(edMeet.link); };
    const join = el('button', 'btn primary small');
    join.type = 'button';
    join.append(icon('video'), 'Join');
    join.onclick = () => desk.openUrl(edMeet.link);
    const copy = el('button', 'btn small');
    copy.type = 'button';
    const copyText = el('span', '', 'Copy');
    copy.append(icon('copy'), copyText);
    copy.onclick = async () => {
      await navigator.clipboard.writeText(edMeet.link);
      copyText.textContent = 'Copied';
      setTimeout(() => { copyText.textContent = 'Copy'; }, 1500);
    };
    box.append(link, join, copy);
    if (edMeet.google && !readOnly) {
      const remove = el('button', 'icon small');
      remove.type = 'button';
      remove.title = 'Remove Google Meet';
      remove.append(icon('dismiss'));
      remove.onclick = () => { edMeet.action = 'remove'; renderMeet(false); };
      box.append(remove);
    }
    return;
  }
  if (edMeet?.action === 'remove') {
    box.append(el('span', 'muted', 'Google Meet will be removed when you save.'));
    const undo = el('button', 'btn subtle small', 'Undo');
    undo.type = 'button';
    undo.onclick = () => { delete edMeet.action; renderMeet(false); };
    box.append(undo);
    return;
  }
  if (edMeet?.action === 'add') {
    box.append(el('span', 'muted', 'A Meet link will be created when you save.'));
    const cancel = el('button', 'btn subtle small', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => { edMeet = null; renderMeet(false); };
    box.append(cancel);
    return;
  }
  if (readOnly) { box.append(el('span', 'muted', 'None')); return; }

  const add = el('button', 'btn');
  add.type = 'button';
  add.append(icon('video'), 'Add Google Meet video conferencing');
  add.onclick = async () => {
    if (!editing) { edMeet = { action: 'add' }; renderMeet(false); return; }
    // Existing event: create the link right away so you can Join/Copy it immediately.
    add.disabled = true;
    try {
      const res = unwrap(await desk.updateEvent({ calendarId: editing.calendarId, eventId: editing.id, meet: 'add' }));
      edMeet = { link: res.meetLink, google: true };
      editing.meetLink = res.meetLink;
      editing.hasGoogleMeet = true;
      renderMeet(false);
      loadEvents();
    } catch (err) { add.disabled = false; status(err.message, true); }
  };
  box.append(add);
}

// ============================================================================
// Notifications (Google Calendar reminders, shown as popups)
// ============================================================================

function renderReminders(readOnly) {
  const box = $('f-reminders');
  box.replaceChildren();
  const cal = calendarById(editing?.calendarId || $('f-calendar').value);
  const defaults = (cal?.defaultReminders || []).map((r) => reminderLabel(r.minutes).replace(' before', ''));

  const mode = el('select');
  mode.append(new Option(`Calendar default${defaults.length ? ` (${defaults.join(', ')} before)` : ' (none)'}`, 'default'));
  mode.append(new Option('Custom', 'custom'));
  mode.value = edReminders === 'default' ? 'default' : 'custom';
  mode.disabled = readOnly;
  mode.onchange = () => {
    edReminders = mode.value === 'default' ? 'default' : (cal?.defaultReminders || []).map((r) => r.minutes);
    if (edReminders !== 'default' && !edReminders.length) edReminders = [10];
    renderReminders(false);
  };
  box.append(mode);
  if (edReminders === 'default') return;

  edReminders.forEach((min, i) => {
    const row = el('div', 'reminder-row');
    const pick = el('select');
    const choices = REMINDER_CHOICES.includes(min) ? REMINDER_CHOICES : [...REMINDER_CHOICES, min].sort((a, b) => a - b);
    for (const c of choices) pick.append(new Option(reminderLabel(c), String(c)));
    pick.value = String(min);
    pick.disabled = readOnly;
    pick.onchange = () => { edReminders[i] = Number(pick.value); };
    const remove = el('button', 'icon small');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.append(icon('dismiss'));
    remove.disabled = readOnly;
    remove.onclick = () => { edReminders.splice(i, 1); renderReminders(false); };
    row.append(icon('alert'), pick, remove);
    box.append(row);
  });
  if (!readOnly && edReminders.length < 5) { // Google allows up to 5
    const add = el('button', 'btn subtle small');
    add.type = 'button';
    add.append(icon('add'), 'Add notification');
    add.onclick = () => { edReminders.push(30); renderReminders(false); };
    box.append(add);
  }
}

// ============================================================================
// Buttons
// ============================================================================

function toggleTimeInputs() {
  const allDay = $('f-allday').checked;
  for (const t of document.querySelectorAll('#editor .time')) t.hidden = allDay;
}
$('f-allday').onchange = () => {
  // Turning "All day" off: give it real times (the next hour, default length) instead of
  // 00:00–00:00, which can't be saved.
  if (!$('f-allday').checked && $('f-stime').value === $('f-etime').value && $('f-sdate').value === $('f-edate').value) {
    const d = new Date(`${$('f-sdate').value}T00:00`);
    const now = new Date();
    const hour = ymd(d) === ymd(now) ? Math.min(23, now.getHours() + 1) : 9;
    const start = atWallMinute(d, hour * 60);
    const end = new Date(+start + state.prefs.defaultEventMinutes * 60000);
    $('f-stime').value = hm(start);
    $('f-edate').value = ymd(end);
    $('f-etime').value = hm(end);
  }
  toggleTimeInputs();
};

/** A problem saving: shown inside the dialog (the status bar is hidden behind it). */
function editorError(text) {
  $('editor-error').textContent = text;
  $('editor-error').hidden = !text;
}
$('btn-cancel').onclick = () => $('editor').close();
$('btn-open-google').onclick = () => editing && desk.openUrl(editing.htmlLink);

// Keep end ≥ start when you change the start date.
$('f-sdate').onchange = () => {
  if ($('f-edate').value < $('f-sdate').value) $('f-edate').value = $('f-sdate').value;
};

$('editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const allDay = $('f-allday').checked;
  // Local date-times like '2026-11-17T18:00' (no "Z"), so they're read as local time.
  const fields = {
    title: $('f-title').value.trim(),
    allDay,
    start: allDay ? $('f-sdate').value : `${$('f-sdate').value}T${$('f-stime').value}`,
    end: allDay ? $('f-edate').value : `${$('f-edate').value}T${$('f-etime').value}`,
    location: $('f-location').value,
    description: $('f-desc').value,
    colorId: edColor,
    reminders: edReminders,
    ...(edMeet?.action ? { meet: edMeet.action } : {}),
  };
  if (!allDay && new Date(fields.end) <= new Date(fields.start)) {
    editorError('End must be after start.');
    return;
  }
  if (allDay && fields.end < fields.start) {
    editorError('End date must not be before the start date.');
    return;
  }
  editorError('');
  // This save belongs to the event open now, even if the dialog is closed or reopened
  // for another event before Google answers.
  const target = editing;
  const session = ++editorSession;
  $('btn-save').disabled = true;
  try {
    const res = target
      ? unwrap(await desk.updateEvent({ calendarId: target.calendarId, eventId: target.id, ...fields }))
      : unwrap(await desk.createEvent({ calendarId: $('f-calendar').value, ...fields }));
    if (session === editorSession) $('editor').close();
    if (!target) state.highlightId = res.id;
    if (fields.meet === 'add' && res.meetLink) {
      showToast('Google Meet link created', 'Copy link', () => navigator.clipboard.writeText(res.meetLink));
    } else {
      status(target ? 'Saved' : 'Created');
    }
    loadEvents();
  } catch (err) {
    if (session === editorSession && $('editor').open) editorError(err.message);
    else status(err.message, true);
  } finally {
    $('btn-save').disabled = false;
  }
});
let editorSession = 0;
$('editor').addEventListener('close', () => { editorSession++; });

// Delete: no confirm box; an "Undo" toast appears instead (see interactions.js).
$('btn-delete').onclick = () => {
  if (!editing) return;
  $('editor').close();
  deleteWithUndo(editing);
};
