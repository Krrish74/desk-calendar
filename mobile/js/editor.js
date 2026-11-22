// editor.js: the full event editor (create / edit / delete) as a full-height sheet,
// with color, Google Meet and notification (reminder) settings.
// Ported from src/renderer/js/editor.js. Dates and times use the iPhone's own wheels
// (<input type="date"> / <input type="time">).

import { el, icon, button, ymd, hm, addDays, fromYmd, textOn, openUrl } from './util.js';
import { openSheet, closeSheet, showToast } from './sheet.js';
import { api } from './api.js';
import { state, emit, status, calendarById, defaultCalendarId, clearCache } from './state.js';
import { deleteWithUndo } from './actions.js';

// Google Calendar's 11 event colors (the IDs Google uses, with today's web-UI shades).
export const GOOGLE_COLORS = [
  ['7', 'Peacock', '#039be5'], ['9', 'Blueberry', '#3f51b5'], ['1', 'Lavender', '#7986cb'],
  ['3', 'Grape', '#8e24aa'], ['4', 'Flamingo', '#e67c73'], ['11', 'Tomato', '#d50000'],
  ['6', 'Tangerine', '#f4511e'], ['5', 'Banana', '#f6bf26'], ['2', 'Sage', '#33b679'],
  ['10', 'Basil', '#0b8043'], ['8', 'Graphite', '#616161'],
];

// Choices for a notification, in minutes before the event.
const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
export function reminderLabel(min) {
  if (min === 0) return 'At time of event';
  if (min % 10080 === 0) return `${min / 10080} week${min > 10080 ? 's' : ''} before`;
  if (min % 1440 === 0) return `${min / 1440} day${min > 1440 ? 's' : ''} before`;
  if (min % 60 === 0) return `${min / 60} hour${min > 60 ? 's' : ''} before`;
  return `${min} minutes before`;
}

/**
 * Open the editor for `ev`, or for a new event when ev is null.
 * `preset` pre-fills a new event: { title, start, end, allDay, calendarId }.
 */
export function openEditor(ev, preset = {}) {
  const isNew = !ev;
  const readOnly = !isNew && !ev.canEdit;
  const src = ev || preset;

  // Defaults for a new event: the next whole hour, "Default event length" long.
  const start = src.start || new Date(Math.ceil(Date.now() / 3600000) * 3600000);
  let end = src.end || new Date(+start + state.prefs.defaultEventMinutes * 60000);
  if (src.allDay) end = addDays(end, -1); // all-day ends are exclusive; show the last day

  let colorId = ev?.colorId || '';
  let meet = ev?.meetLink ? { link: ev.meetLink, google: ev.hasGoogleMeet } : null; // + .action: 'add' | 'remove'
  const r = ev?.reminders;
  let reminders = !r || r.useDefault ? 'default' : (r.overrides || []).map((o) => o.minutes);

  const body = el('div');
  if (readOnly) body.append(el('div', 'ed-readonly', `This event is on “${ev.calendarName}”, which you can view but not change.`));

  const title = input('text', src.title || '', 'ed-title');
  title.placeholder = 'Add title';
  title.enterKeyHint = 'done';
  body.append(title);

  // All day
  const allDay = el('input', 'toggle');
  allDay.type = 'checkbox';
  allDay.checked = !!src.allDay;
  body.append(row('clock', [el('span', 'label', 'All day'), allDay]));

  // Start / end
  const sDate = input('date', ymd(start)), sTime = input('time', hm(start));
  const eDate = input('date', ymd(end)), eTime = input('time', hm(end));
  const startTimes = el('div', 'ed-times'); startTimes.append(sDate, sTime);
  const endTimes = el('div', 'ed-times'); endTimes.append(eDate, eTime);
  const startRow = row(null, [el('span', 'label', 'Starts'), startTimes]);
  const endRow = row(null, [el('span', 'label', 'Ends'), endTimes]);
  for (const rr of [startRow, endRow]) { rr.querySelector('.label').style.flex = '0 0 52px'; rr.style.paddingLeft = '36px'; }
  body.append(startRow, endRow);
  const toggleTimes = () => {
    for (const t of [sTime, eTime]) t.hidden = allDay.checked;
    for (const t of [startTimes, endTimes]) t.classList.toggle('allday', allDay.checked);
  };
  allDay.onchange = toggleTimes;
  toggleTimes();
  // Keep the end after the start when you change the start (same length as before).
  let lengthMs = +end - +start;
  const startValue = () => new Date(`${sDate.value}T${sTime.value || '00:00'}`);
  const endValue = () => new Date(`${eDate.value}T${eTime.value || '00:00'}`);
  const onStartChange = () => {
    if (allDay.checked) { if (eDate.value < sDate.value) eDate.value = sDate.value; return; }
    const e2 = new Date(+startValue() + Math.max(lengthMs, 15 * 60000));
    eDate.value = ymd(e2); eTime.value = hm(e2);
  };
  sDate.onchange = onStartChange; sTime.onchange = onStartChange;
  const onEndChange = () => { lengthMs = +endValue() - +startValue(); };
  eDate.onchange = onEndChange; eTime.onchange = onEndChange;

  // Calendar (only calendars you can write to; an existing event stays where it is)
  const cal = el('select');
  for (const c of state.calendars.filter((x) => x.canEdit || x.id === ev?.calendarId)) cal.append(new Option(c.name, c.id));
  cal.value = ev ? ev.calendarId : (preset.calendarId || defaultCalendarId());
  cal.disabled = !isNew;
  body.append(row('calendar_ltr', [cal]));

  // Color
  const swatches = el('div', 'swatches');
  const renderColors = () => {
    swatches.replaceChildren();
    const calColor = calendarById(cal.value)?.color || '#7aa2ff';
    for (const [id, name, hex] of [['', 'Calendar color', calColor], ...GOOGLE_COLORS]) {
      const b = button(`swatch${id === '' ? ' default' : ''}${id === colorId ? ' selected' : ''}`, id === colorId ? [icon('checkmark')] : [], () => { colorId = id; renderColors(); });
      b.style.background = hex;
      b.style.color = textOn(hex);
      b.setAttribute('aria-label', name);
      b.disabled = readOnly;
      swatches.append(b);
    }
  };
  body.append(row('color', [swatches]));

  // Google Meet
  const meetBox = el('div', 'ed-stack');
  const renderMeet = () => {
    meetBox.replaceChildren();
    if (meet?.link && meet.action !== 'remove') {
      const link = el('a', 'meet-link', meet.link.replace(/^https:\/\//, ''));
      link.href = meet.link; link.target = '_blank'; link.rel = 'noopener';
      const btns = el('div', 'qa-buttons');
      btns.append(button('btn primary small', [icon('video'), 'Join'], () => openUrl(meet.link)));
      const copyText = el('span', '', 'Copy');
      btns.append(button('btn small', [icon('copy'), copyText], async () => {
        try { await navigator.clipboard.writeText(meet.link); copyText.textContent = 'Copied'; } catch { /* clipboard blocked */ }
      }));
      if (meet.google && !readOnly) btns.append(button('btn small danger', 'Remove', () => { meet.action = 'remove'; renderMeet(); }));
      meetBox.append(link, btns);
    } else if (meet?.action === 'remove') {
      meetBox.append(el('span', 'muted', 'Google Meet will be removed when you save.'), button('btn subtle small', 'Undo', () => { delete meet.action; renderMeet(); }));
    } else if (meet?.action === 'add') {
      meetBox.append(el('span', 'muted', 'A Meet link will be created when you save.'), button('btn subtle small', 'Cancel', () => { meet = null; renderMeet(); }));
    } else if (readOnly) {
      meetBox.append(el('span', 'muted', 'No video call'));
    } else {
      meetBox.append(button('btn', [icon('video'), 'Add Google Meet'], () => { meet = { action: 'add' }; renderMeet(); }));
    }
  };
  body.append(row('video', [meetBox], true));

  // Notifications
  const remBox = el('div', 'ed-stack');
  const renderReminders = () => {
    remBox.replaceChildren();
    const c = calendarById(ev?.calendarId || cal.value);
    const defaults = (c?.defaultReminders || []).map((x) => reminderLabel(x.minutes).replace(' before', ''));
    const mode = el('select');
    mode.append(new Option(`Calendar default${defaults.length ? ` (${defaults.join(', ')})` : ' (none)'}`, 'default'), new Option('Custom', 'custom'));
    mode.value = reminders === 'default' ? 'default' : 'custom';
    mode.disabled = readOnly;
    mode.onchange = () => {
      reminders = mode.value === 'default' ? 'default' : (c?.defaultReminders || []).map((x) => x.minutes);
      if (reminders !== 'default' && !reminders.length) reminders = [10];
      renderReminders();
    };
    remBox.append(mode);
    if (reminders === 'default') return;
    reminders.forEach((min, i) => {
      const rr = el('div', 'reminder-row');
      const pick = el('select');
      const choices = REMINDER_CHOICES.includes(min) ? REMINDER_CHOICES : [...REMINDER_CHOICES, min].sort((a, b) => a - b);
      for (const ch of choices) pick.append(new Option(reminderLabel(ch), String(ch)));
      pick.value = String(min);
      pick.disabled = readOnly;
      pick.onchange = () => { reminders[i] = Number(pick.value); };
      const remove = button('icon', [icon('dismiss')], () => { reminders.splice(i, 1); renderReminders(); });
      remove.setAttribute('aria-label', 'Remove notification');
      remove.disabled = readOnly;
      rr.append(pick, remove);
      remBox.append(rr);
    });
    if (!readOnly && reminders.length < 5) { // Google allows up to 5
      remBox.append(button('btn subtle small', [icon('add'), 'Add notification'], () => { reminders.push(30); renderReminders(); }));
    }
  };
  body.append(row('alert', [remBox], true));
  cal.onchange = () => { renderColors(); renderReminders(); };
  renderColors(); renderMeet(); renderReminders();

  // Location + description
  const location = input('text', ev?.location || '');
  location.placeholder = 'Add location';
  body.append(row('location', [location]));
  const desc = el('textarea');
  desc.rows = 4;
  desc.value = ev?.description || '';
  desc.placeholder = 'Add description';
  body.append(row('text_description', [desc], true));

  if (readOnly) for (const x of body.querySelectorAll('input, textarea, select')) x.disabled = true;

  if (!isNew && !readOnly) {
    body.append(button('btn danger block ed-delete', [icon('delete'), 'Delete event'], () => { closeSheet(); deleteWithUndo(ev); }));
  }
  if (!isNew) body.append(button('btn subtle block', [icon('open'), 'Open in Google Calendar'], () => openUrl(ev.htmlLink)));

  // Save
  const save = button('btn primary small', 'Save', async () => {
    const isAllDay = allDay.checked;
    const s = startValue(), e = endValue();
    if (!isAllDay && e <= s) { status('The end must be after the start.', true); return; }
    if (isAllDay && eDate.value < sDate.value) { status('The last day must be on or after the first.', true); return; }
    const fields = {
      title: title.value.trim() || '(No title)',
      allDay: isAllDay,
      start: isAllDay ? sDate.value : s.toISOString(),
      end: isAllDay ? eDate.value : e.toISOString(),
      location: location.value,
      description: desc.value,
      colorId,
      reminders,
      ...(meet?.action ? { meet: meet.action } : {}),
    };
    save.disabled = true;
    try {
      const res = ev
        ? await api.updateEvent({ calendarId: ev.calendarId, eventId: ev.id, ...fields })
        : await api.createEvent({ calendarId: cal.value, ...fields });
      closeSheet();
      clearCache();
      if (fields.meet === 'add' && res.meetLink) {
        showToast('Google Meet link created', 'Copy link', () => navigator.clipboard.writeText(res.meetLink).catch(() => {}));
      } else {
        status(ev ? 'Saved' : 'Created');
      }
      if (!ev) { state.highlightId = res.id; emit('goto', isAllDay ? fromYmd(sDate.value) : s); } else emit('reload');
    } catch (err) {
      status(err.message, true);
      save.disabled = false;
    }
  });

  openSheet({
    title: isNew ? 'New event' : readOnly ? 'Event' : 'Edit event',
    body,
    full: true,
    actions: readOnly ? [] : [save],
  });
  // Focus during the tap that opened the editor, so iPhone shows the keyboard.
  if (isNew && !preset.title) title.focus({ preventScroll: true });
}

function input(type, value, className = '') {
  const i = el('input', className);
  i.type = type;
  i.value = value;
  return i;
}

/** An editor row: icon on the left, controls on the right. */
function row(iconName, children, top = false) {
  const r = el('div', `ed-row${top ? ' top' : ''}`);
  if (iconName) r.append(icon(iconName));
  r.append(...children);
  return r;
}
