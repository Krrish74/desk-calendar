// settings.js: the Settings sheet (gear button). Every change is saved to the Worker
// right away (PATCH /api/prefs), so it follows you if you reinstall the app.
// These are the phone's own settings, separate from the desktop app's.

import { el, icon, button, setTimeFormat } from './util.js';
import { openSheet, closeSheet } from './sheet.js';
import { api } from './api.js';
import { state, emit, status, loadCalendars, clearCache } from './state.js';
import { pushSupport, currentSubscription, turnOn, turnOff } from './push.js';
import { GOOGLE_COLORS } from './editor.js';
import { clearChatLog } from './chat.js';

export async function openSettings() {
  const body = el('div');
  const sheet = openSheet({ title: 'Settings', body, full: true });
  body.append(el('p', 'muted', 'Loading…'));
  await loadCalendars(true);
  let models = null;
  try { models = await api.assistantSettings(); } catch { /* shown as unavailable */ }
  if (!sheet.node.isConnected) return; // closed while loading
  body.replaceChildren();

  const save = async (changes) => {
    try {
      state.prefs = await api.setPrefs(changes);
      setTimeFormat(state.prefs.timeFormat);
    } catch (err) { status(err.message, true); }
  };

  // --- Calendars -----------------------------------------------------------------
  const cals = card();
  for (const c of state.calendars) {
    const sw = el('span', 'cal-swatch');
    sw.style.background = c.color;
    const t = toggle(c.visible, async (on) => {
      c.visible = on;
      try { await api.setCalendarVisible(c.id, on); clearCache(); emit('reload'); } catch (err) { status(err.message, true); }
    });
    cals.append(setRow([sw, label(c.name, c.canEdit ? '' : 'View only')], t));
  }
  body.append(group('Calendars', cals, 'Choose which calendars show in the app. This doesn\'t change Google Calendar.'));

  // --- Events -----------------------------------------------------------------------
  const writable = state.calendars.filter((c) => c.canEdit);
  const events = card();
  events.append(
    setRow([label('Default calendar', 'For new events and quick add without a #tag')],
      select([[ '', 'Primary calendar' ], ...writable.map((c) => [c.id, c.name])], state.prefs.defaultCalendarId || '',
        (v) => save({ defaultCalendarId: v || null }))),
    setRow([label('Default length')],
      select([[15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours']],
        state.prefs.defaultEventMinutes, (v) => save({ defaultEventMinutes: Number(v) }))),
  );
  body.append(group('New events', events));

  // --- Google Tasks lists (filled in when loaded; see tasksGroup) ------------------------
  const tasksSlot = el('div');
  body.append(tasksSlot);
  tasksGroup(save).then((g) => tasksSlot.replaceWith(g)).catch(() => tasksSlot.remove());

  // --- Display ------------------------------------------------------------------------
  const display = card();
  display.append(
    setRow([label('Time format')], select([['system', 'iPhone setting'], ['12', '12-hour'], ['24', '24-hour']], state.prefs.timeFormat,
      async (v) => { await save({ timeFormat: v }); emit('render'); emit('countdown'); })),
    setRow([label('Week starts on')], select([[0, 'Sunday'], [1, 'Monday']], state.prefs.weekStartsOn,
      async (v) => { await save({ weekStartsOn: Number(v) }); emit('navigate'); })),
  );
  body.append(group('Display', display));

  // --- Assistant ------------------------------------------------------------------------
  const asst = card();
  if (models) {
    asst.append(setRow([label('Model', 'Haiku is fast and cheap; Sonnet and Opus are more careful')],
      select(models.models.map((m) => [m.id, m.label.split(' — ')[0]]), models.current, (v) => save({ assistantModel: v }))));
  } else {
    asst.append(setRow([label('Model', 'Couldn\'t load the model list')], el('span')));
  }
  // What the assistant has cost: "Last message ≈ $0.0011 · This month ≈ $0.04 (37 messages)".
  asst.append(setRow([label('Spending', usageText(models?.usage))], el('span')));
  body.append(group('Assistant', asst, 'Switching models starts a new conversation. The Claude API key lives on your Worker, not on this phone.'));
  if (models) body.append(aboutYouGroup(models.profile));

  // --- Reminders (push notifications, see push.js) -------------------------------------------
  // Its own slot, filled in when ready: a slow or broken reminders check must never hide
  // the rest of Settings (Sign out is below).
  const remindersSlot = el('div');
  body.append(remindersSlot);
  remindersGroup(save).then((g) => remindersSlot.replaceWith(g)).catch((err) => {
    const box = card();
    box.append(setRow([label('Reminders', err.message)], el('span')));
    remindersSlot.replaceWith(group('Reminders', box));
  });

  // --- Account ----------------------------------------------------------------------------
  const acct = card();
  acct.append(setRow([label(state.me?.email || '', state.me?.sample ? 'Sample data (local testing)' : 'Signed in with Google')], el('span')));
  acct.append(setRow([label('Sign out', 'Only on this phone (its reminders stop too)')], button('btn small', [icon('sign_out'), 'Sign out'], async () => {
    await turnOff().catch(() => {}); // a signed-out phone shouldn't keep getting reminders
    try { await api.signOut(false); } catch { /* signed out anyway */ }
    closeSheet();
    emit('signedOut', 'You signed out.');
  })));
  acct.append(setRow([label('Sign out everywhere', 'Also removes Desk Calendar\'s access to your Google account')],
    button('btn small danger', 'Disconnect', async () => {
      if (!confirm('Sign out on every device and remove Desk Calendar\'s access to your Google Calendar?')) return;
      await turnOff().catch(() => {});
      try { await api.signOut(true); } catch { /* signed out anyway (the Worker also drops every device's reminders) */ }
      closeSheet();
      emit('signedOut', 'Signed out everywhere. Google access removed.');
    })));
  body.append(group('Account', acct));
}

/**
 * Settings → Reminders:
 *   This iPhone            on/off switch: subscribes this device (permission prompt)
 *   Remind me              N minutes before (shared by all devices)
 *   Send a test reminder
 * plus why it can't be turned on here (not on the Home Screen, old iOS, Worker not set up).
 */
async function remindersGroup(save) {
  const box = card();
  const push = state.me?.push || {};
  const support = pushSupport();
  const note = 'Silent notifications before timed events (all-day events and declined meetings are skipped). '
    + 'On iPhone this needs iOS 16.4 or later and Desk Calendar opened from its Home Screen icon: in Safari tap Share → "Add to Home Screen".';

  const lead = select([[0, 'At start time'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'],
    [30, '30 minutes before'], [60, '1 hour before']], state.prefs.notifyMinutes, (v) => save({ notifyMinutes: Number(v) }));

  if (!push.configured) {
    box.append(setRow([label('Reminders', 'Not set up on the Worker yet: the VAPID keys are missing (see SETUP-IPHONE.md).')], el('span')));
    return group('Reminders', box, note);
  }
  if (!support.ok) {
    box.append(setRow([label('This device', support.why)], el('span')));
    box.append(setRow([label('Remind me')], lead));
    return group('Reminders', box, note);
  }

  const sub = await currentSubscription().catch(() => null);
  const on = !!sub && Notification.permission === 'granted' && state.prefs.notifyEnabled;
  const devices = el('div', 'desc', deviceText(push.devices));
  const thisDevice = toggle(on, (wantOn) => {
    // Called straight from the tap, so iPhone allows the permission prompt.
    const work = wantOn
      ? turnOn(push.publicKey).then(async (r) => { if (!state.prefs.notifyEnabled) await save({ notifyEnabled: true }); return r; })
      : turnOff();
    work.then((r) => {
      if (r) devices.textContent = deviceText(r.devices);
      status(wantOn ? 'Reminders on for this device' : 'Reminders off for this device');
    }).catch((err) => {
      thisDevice.checked = !wantOn;
      status(err.message, true);
    });
  });
  const l = label('This device');
  l.append(devices);
  box.append(setRow([l], thisDevice));
  box.append(setRow([label('Remind me')], lead));
  box.append(setRow([label('Send a test reminder', 'To every device with reminders on')], button('btn small', 'Send', async () => {
    try {
      const r = await api.pushTest();
      status(r.failed ? `Sent to ${r.sent}, failed on ${r.failed}` : `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}`, !!r.failed);
    } catch (err) { status(err.message, true); }
  })));
  return group('Reminders', box, note);
}

const deviceText = (n) => (n ? `${n} device${n === 1 ? '' : 's'} with reminders on` : 'No devices yet');

/** Settings → Tasks: which Google Tasks lists show, and where new tasks go. */
async function tasksGroup(save) {
  const box = card();
  let lists;
  try {
    lists = await api.taskLists(true);
  } catch (err) {
    box.append(setRow([label('Google Tasks', err.message)], err.code === 'TASKS_SCOPE'
      ? button('btn small primary', 'Connect', () => { location.href = '/auth/login'; })
      : el('span')));
    return group('Tasks', box);
  }
  state.taskLists = lists;
  for (const l of lists) {
    box.append(setRow([icon('task_list_ltr'), label(l.name)], toggle(l.visible, async (on) => {
      try { await api.setTaskListVisible(l.id, on); emit('reload'); } catch (err) { status(err.message, true); }
    })));
  }
  box.append(setRow([label('New tasks go to')],
    select([['', 'My main list'], ...lists.map((l) => [l.id, l.name])], state.prefs.defaultTaskListId || '',
      (v) => save({ defaultTaskListId: v || null }))));
  return group('Tasks', box, 'Which Google Tasks lists appear in "Today\'s tasks" and the Agenda.');
}

/** "Last message ≈ $0.0011 · This month ≈ $0.04 (37 messages)" (same wording as desktop). */
function usageText(u) {
  if (!u) return 'No messages yet this month.';
  const money = (v) => (v == null ? '?' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
  const last = u.last ? `Last message ≈ ${money(u.last.cost)}` : '';
  const month = `This month ≈ ${money(u.cost)} (${u.messages} message${u.messages === 1 ? '' : 's'})`;
  return [last, month].filter(Boolean).join(' · ');
}

/**
 * Settings → About you: how you like to work, for the assistant's planning. Same fields
 * as the desktop app (freetime.js PROFILE_DEFAULTS). Each change is saved (the Worker
 * cleans it up) and starts a fresh assistant conversation.
 */
function aboutYouGroup(initial) {
  let profile = { ...initial };
  const box = card();
  const saveProfile = async (changes) => {
    try {
      state.prefs = await api.setPrefs({ userProfile: { ...profile, ...changes } });
      profile = { ...profile, ...changes, ...(state.prefs.userProfile || {}) };
      clearChatLog();
      status('Saved. The assistant uses this from your next message.');
      render();
    } catch (err) { status(err.message, true); }
  };

  const days = el('div', 'day-picks');
  const colors = el('div', 'swatches');
  const render = () => {
    days.replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((d) => {
      const on = profile.workDays.includes(d);
      const b = button(`day-pick${on ? ' on' : ''}`, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d][0], () => {
        saveProfile({ workDays: on ? profile.workDays.filter((x) => x !== d) : [...profile.workDays, d] });
      });
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]);
      return b;
    }));
    colors.replaceChildren(...[['', 'Calendar color', '#7aa2ff'], ...GOOGLE_COLORS].map(([id, name, hex]) => {
      const b = button(`swatch${id === '' ? ' default' : ''}${id === profile.blockColorId ? ' selected' : ''}`, id === profile.blockColorId ? [icon('checkmark')] : [], () => saveProfile({ blockColorId: id }));
      b.style.background = hex;
      b.setAttribute('aria-label', name);
      return b;
    }));
  };
  render();

  const time = (key) => {
    const i = el('input');
    i.type = 'time';
    i.value = profile[key] || '';
    i.className = 'set-time';
    i.onchange = () => saveProfile({ [key]: i.value });
    return i;
  };
  const pair = (a, b) => { const w = el('div', 'set-pair'); w.append(time(a), el('span', 'muted', '–'), time(b)); return w; };
  const minutes = (key, options) => select(options.map((m) => [m, m === 0 ? 'None' : `${m} min`]), profile[key], (v) => saveProfile({ [key]: Number(v) }));

  const daysRow = el('div', 'set-row set-col');
  daysRow.append(label('Working days'), days);
  box.append(daysRow);
  box.append(setRow([label('Working hours')], pair('dayStart', 'dayEnd')));
  box.append(setRow([label('Lunch', 'Clear both times for no lunch break')], pair('lunchStart', 'lunchEnd')));
  box.append(setRow([label('Best focus time')], select([['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening'], ['none', 'No preference']],
    profile.focusTime, (v) => saveProfile({ focusTime: v }))));
  box.append(setRow([label('Usual work block')], minutes('blockMinutes', [30, 45, 60, 90, 120])));
  box.append(setRow([label('Longest block')], minutes('maxBlockMinutes', [60, 90, 120, 180, 240])));
  box.append(setRow([label('Break between blocks')], minutes('breakMinutes', [0, 5, 10, 15, 30])));
  box.append(setRow([label('Free time around meetings')], minutes('meetingBuffer', [0, 5, 10, 15, 30])));
  const colorRow = el('div', 'set-row set-col');
  colorRow.append(label('Color for time blocks'), colors);
  box.append(colorRow);

  const notes = el('textarea');
  notes.rows = 4;
  notes.maxLength = 1500;
  notes.value = profile.notes || '';
  notes.placeholder = 'Anything else about how you work (e.g. "gym Tue/Thu 6pm", "no meetings Friday afternoon")';
  const count = el('div', 'desc', `${notes.value.length} / 1500`);
  notes.addEventListener('input', () => { count.textContent = `${notes.value.length} / 1500`; });
  notes.addEventListener('change', () => saveProfile({ notes: notes.value }));
  const notesRow = el('div', 'set-row set-col');
  notesRow.append(label('In your own words'), notes, count);
  box.append(notesRow);
  return group('About you', box, 'The assistant follows this when it plans your tasks into time blocks. Changing it starts a new conversation.');
}

// --- Small builders ---------------------------------------------------------------------

const card = () => el('div', 'set-card');

function group(title, content, note) {
  const g = el('div', 'set-group');
  g.append(el('h3', '', title), content);
  if (note) g.append(el('p', 'set-note', note));
  return g;
}

function setRow(left, right) {
  const r = el('div', 'set-row');
  r.append(...left, right);
  return r;
}

function label(title, desc) {
  const l = el('div', 'label');
  l.append(el('div', '', title));
  if (desc) l.append(el('div', 'desc', desc));
  return l;
}

function toggle(checked, onChange) {
  const t = el('input', 'toggle');
  t.type = 'checkbox';
  t.checked = checked;
  t.onchange = () => onChange(t.checked);
  return t;
}

function select(options, value, onChange) {
  const s = el('select');
  for (const [v, text] of options) s.append(new Option(text, String(v)));
  s.value = String(value ?? '');
  s.onchange = () => onChange(s.value);
  return s;
}
