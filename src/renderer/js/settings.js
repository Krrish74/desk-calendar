// settings.js: the Settings page (General · Calendars · Assistant · Account).
//
// Every control saves immediately (no "Save" button), like Windows Settings / macOS System Settings.
// Preferences live in prefs.json via the backend (src/main/prefs.js);
// secrets (AI API keys) go to secureStore instead.

function openSettings() {
  if ($('app').hidden) return;
  closePopover();
  $('toolbar').hidden = true;
  $('workspace').hidden = true;
  $('settings-page').hidden = false;
  fillSettings();
}

function closeSettings() {
  $('settings-page').hidden = true;
  $('toolbar').hidden = false;
  $('workspace').hidden = false;
  refreshScreen(); // settings like week start or time format change how things are drawn
}

$('btn-settings').onclick = openSettings;
$('sp-back').onclick = closeSettings;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings-page').hidden && !e.target.closest('#s-hotkey')) closeSettings();
});

// Section links on the left scroll to that section; the link highlights as you scroll.
for (const b of document.querySelectorAll('.sp-nav button')) {
  b.onclick = () => $(`sec-${b.dataset.sec}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('sp-content').addEventListener('scroll', () => {
  const top = $('sp-content').getBoundingClientRect().top;
  let current = 'general';
  for (const s of document.querySelectorAll('.sp-section')) {
    if (s.getBoundingClientRect().top - top < 80) current = s.id.replace('sec-', '');
  }
  for (const b of document.querySelectorAll('.sp-nav button')) b.classList.toggle('active', b.dataset.sec === current);
});

/** Save one or more preferences and keep the page's copy in sync. */
async function savePrefs(changes) {
  try {
    unwrap(await desk.setPrefs(changes));
    Object.assign(state.prefs, changes);
    return true;
  } catch (err) {
    status(err.message, true);
    return false;
  }
}

// ============================================================================
// Fill the page from the current preferences
// ============================================================================

async function fillSettings() {
  const { prefs, hotkeyLabel, hotkeyStatus, isPackaged } = unwrap(await desk.getPrefs());
  state.prefs = prefs;
  fillSync();

  // General: simple selects named p-<prefName>
  const cals = state.calendars.filter((c) => c.canEdit);
  $('p-defaultCalendarId').replaceChildren(new Option('Primary calendar', ''), ...cals.map((c) => new Option(c.name, c.id)));
  for (const name of ['startView', 'weekStartsOn', 'agendaDays', 'timeFormat', 'defaultEventMinutes', 'defaultCalendarId', 'notifyMinutes']) {
    $(`p-${name}`).value = String(prefs[name] ?? '');
  }
  $('p-notifyEnabled').checked = prefs.notifyEnabled;
  $('p-notifyMinutes').disabled = !prefs.notifyEnabled;

  // Background
  $('s-startup').checked = prefs.startWithWindows;
  $('s-start-hidden').checked = prefs.startHidden;
  $('s-start-hidden').disabled = !prefs.startWithWindows;
  $('s-startup-note').hidden = isPackaged;
  $('s-hotkey').value = hotkeyLabel;
  setHotkeyMsg(hotkeyStatus.ok ? 'Works from any app. Click the box, then press new keys.' : hotkeyStatus.error, !hotkeyStatus.ok);

  renderSettingsCalendars();
  await fillTaskListSettings(prefs);

  // Assistant
  await fillAssistant();

  // Account
  const account = await desk.account();
  $('s-account').textContent = account.data ? `Signed in as ${account.data}` : 'Signed in';
}

// Number-valued selects are saved as numbers, the rest as strings ('' = none).
const NUMERIC = new Set(['weekStartsOn', 'agendaDays', 'defaultEventMinutes', 'notifyMinutes']);
for (const name of ['startView', 'weekStartsOn', 'agendaDays', 'timeFormat', 'defaultEventMinutes', 'defaultCalendarId', 'notifyMinutes']) {
  $(`p-${name}`).addEventListener('change', async (e) => {
    let value = e.target.value;
    if (NUMERIC.has(name)) value = Number(value);
    if (name === 'defaultCalendarId' && !value) value = null;
    if (await savePrefs({ [name]: value })) applyPrefs();
  });
}
$('p-defaultTaskListId').addEventListener('change', (e) => savePrefs({ defaultTaskListId: e.target.value || null }));

$('p-notifyEnabled').onchange = async () => {
  await savePrefs({ notifyEnabled: $('p-notifyEnabled').checked });
  $('p-notifyMinutes').disabled = !$('p-notifyEnabled').checked;
};
$('btn-notify-test').onclick = () => desk.notifyTest();

// ============================================================================
// Calendars
// ============================================================================

function renderSettingsCalendars() {
  const list = $('sp-cal-list');
  list.replaceChildren();
  for (const cal of state.calendars) {
    const row = el('div', 'srow');
    const left = el('div', 'cal-name');
    const sw = el('span', 'cal-swatch');
    sw.style.background = cal.color;
    const text = el('div');
    text.append(el('div', 'srow-title', cal.name));
    text.append(el('div', 'srow-desc', [cal.primary ? 'Primary' : '', cal.canEdit ? '' : 'View only'].filter(Boolean).join(' · ')));
    left.append(sw, text);
    const toggle = el('input', 'toggle');
    toggle.type = 'checkbox';
    toggle.checked = cal.visible;
    toggle.onchange = async () => {
      cal.visible = toggle.checked;
      await desk.setCalendarVisible(cal.id, toggle.checked);
      renderCalendarList(); // the sidebar's list too
    };
    row.append(left, toggle);
    list.append(row);
  }
}

// Google Tasks lists: show/hide (Calendars section) and the default list (General).
async function fillTaskListSettings(prefs) {
  const res = await desk.getTaskLists();
  const lists = res.data || [];
  state.taskLists = lists;
  $('p-defaultTaskListId').replaceChildren(new Option('My main list', ''), ...lists.map((l) => new Option(l.name, l.id)));
  $('p-defaultTaskListId').value = prefs.defaultTaskListId || '';
  $('p-defaultTaskListId').disabled = !!res.error;
  $('sp-tasklist-note').textContent = res.error
    ? 'Google Tasks isn\'t connected yet: use "Connect Google Tasks" in the sidebar.'
    : 'Which Google Tasks lists appear in "Today\'s tasks" and the Agenda.';
  $('sp-tasklist-list').replaceChildren(...lists.map((l) => {
    const row = el('div', 'srow');
    const left = el('div', 'cal-name');
    left.append(icon('task_list_ltr'), el('div', 'srow-title', l.name));
    const toggle = el('input', 'toggle');
    toggle.type = 'checkbox';
    toggle.checked = l.visible;
    toggle.onchange = async () => {
      l.visible = toggle.checked;
      await desk.setTaskListVisible(l.id, toggle.checked);
      loadTasks();
    };
    row.append(left, toggle);
    return row;
  }));
}

// ============================================================================
// Background: start with Windows, start hidden, global hotkey
// ============================================================================

function setHotkeyMsg(text, isError = false, isOk = false) {
  $('s-hotkey-msg').textContent = text;
  $('s-hotkey-msg').className = `srow-desc ${isError ? 'error-text' : isOk ? 'ok-text' : ''}`;
}

$('s-startup').onchange = async () => {
  await savePrefs({ startWithWindows: $('s-startup').checked });
  $('s-start-hidden').disabled = !$('s-startup').checked;
};
$('s-start-hidden').onchange = () => savePrefs({ startHidden: $('s-start-hidden').checked });

// Shortcut recorder: click the box, press e.g. Ctrl+Alt+K (Cmd+Option+K on a Mac). Esc cancels.
let hotkeyBefore = '';
$('s-hotkey').addEventListener('focus', () => {
  hotkeyBefore = $('s-hotkey').value;
  $('s-hotkey').value = 'Press the new shortcut…';
  $('s-hotkey').classList.add('recording');
});
$('s-hotkey').addEventListener('blur', () => {
  if ($('s-hotkey').classList.contains('recording')) $('s-hotkey').value = hotkeyBefore;
  $('s-hotkey').classList.remove('recording');
});
$('s-hotkey').addEventListener('keydown', async (e) => {
  e.preventDefault();
  e.stopPropagation(); // don't let Esc leave the page
  if (e.key === 'Escape') { $('s-hotkey').blur(); return; }
  const accel = toAccelerator(e);
  if (!accel) return; // only modifiers so far: keep waiting
  $('s-hotkey').classList.remove('recording');
  $('s-hotkey').blur();
  try {
    unwrap(await desk.setPrefs({ hotkey: accel }));
    $('s-hotkey').value = prettyAccel(accel);
    setHotkeyMsg('✔ Shortcut saved.', false, true);
  } catch (err) {
    $('s-hotkey').value = hotkeyBefore;
    setHotkeyMsg(err.message, true);
  }
});

/** Turn a keydown event into an Electron accelerator, e.g. 'CommandOrControl+Shift+Space'.
 *  Needs at least one of Ctrl/Alt (Windows) or Cmd/Ctrl/Option (Mac) plus a normal key, so it
 *  can't clash with typing. On a Mac, Cmd is 'CommandOrControl' and Ctrl is 'Control'. */
function toAccelerator(e) {
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
  let key = named[e.key];
  if (!key && /^F\d{1,2}$/.test(e.key)) key = e.key;
  if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);   // layout-independent letters
  if (!key && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (IS_MAC) {
    if (!key || !(e.metaKey || e.ctrlKey || e.altKey)) return null;
    return [e.metaKey && 'CommandOrControl', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
      .filter(Boolean).join('+');
  }
  if (!key || !(e.ctrlKey || e.altKey)) return null;
  return [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

// ============================================================================
// Assistant + Account
// ============================================================================

// Settings → Assistant. The list of providers comes from src/main/providers.js.
let assistantInfo = null;

async function fillAssistant() {
  const info = unwrap(await desk.chatSettings());
  assistantInfo = info;
  const p = info.providers.find((x) => x.id === info.provider);
  $('s-provider').replaceChildren(...info.providers.map((x) => new Option(x.label, x.id)));
  $('s-provider').value = info.provider;
  $('s-provider-note').textContent = p.note;

  const isClaude = p.kind === 'anthropic';
  $('row-claude-model').hidden = !isClaude;
  $('row-model').hidden = isClaude;
  $('row-baseurl').hidden = isClaude;
  if (isClaude) {
    $('p-assistantModel').replaceChildren(...info.claudeModels.map((m) => new Option(m.label, m.id)));
    $('p-assistantModel').value = info.model;
  } else {
    $('s-model').value = info.model;
    $('s-model').placeholder = p.model || 'model id, e.g. openai/gpt-oss-20b';
    $('s-model-list').replaceChildren();
    $('s-baseurl').value = info.baseUrl;
    $('s-baseurl').placeholder = p.baseUrl || 'https://example.com/v1';
    setModelMsg('Its id, exactly as the provider writes it. It must support tool (function) calling.');
  }

  // Local servers (Ollama, LM Studio) don't need a key.
  $('row-key').hidden = p.local;
  $('s-key-title').textContent = p.id === 'custom' ? 'API key (optional)' : `${p.name} API key${p.keyRequired ? '' : ' (optional)'}`;
  $('s-key').value = '';
  $('s-key').placeholder = p.keyHint || '';
  $('s-key-link').hidden = !p.keyUrl;
  $('s-key-link').onclick = () => desk.openUrl(p.keyUrl);
  $('s-key-status').textContent = info.keySaved
    ? `✔ A key is saved (encrypted with ${SECRET_HOME}). Paste a new one to replace it.`
    : info.keyFromEnv ? `Using the ${info.keyEnv} environment variable.`
    : p.keyRequired ? 'No key saved yet.' : 'Only needed if your server checks keys.';

  fillProfile(info.profile);
  showUsage(info.usage);
}

// --- About you (the assistant's profile) ------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let profile = null;

function fillProfile(p) {
  profile = { ...p };
  $('pf-days').replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((d) => {
    const on = p.workDays.includes(d);
    const b = el('button', `day-pick${on ? ' on' : ''}`, DAY_NAMES[d]);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.onclick = () => {
      const days = on ? profile.workDays.filter((x) => x !== d) : [...profile.workDays, d];
      saveProfile({ workDays: days });
    };
    return b;
  }));
  for (const k of ['dayStart', 'dayEnd', 'lunchStart', 'lunchEnd', 'focusTime', 'blockMinutes', 'maxBlockMinutes', 'breakMinutes', 'meetingBuffer']) {
    $(`pf-${k}`).value = String(p[k] ?? '');
  }
  $('pf-notes').value = p.notes;
  $('pf-notes-count').textContent = `${p.notes.length} / 1500`;
  renderBlockColors();
}

function renderBlockColors() {
  const box = $('pf-blockColor');
  box.replaceChildren(...[['', 'Calendar color', '#7aa2ff'], ...GOOGLE_COLORS].map(([id, name, hex]) => {
    const b = el('button', `swatch${id === '' ? ' default' : ''}${id === profile.blockColorId ? ' selected' : ''}`);
    b.type = 'button';
    b.title = name;
    b.style.background = hex;
    b.style.color = textOn(hex);
    if (id === profile.blockColorId) b.append(icon('checkmark'));
    b.onclick = () => saveProfile({ blockColorId: id });
    return b;
  }));
}

/** Save profile changes; the backend validates them and starts a fresh chat. */
async function saveProfile(changes) {
  try {
    const info = unwrap(await desk.chatSetSettings({ profile: { ...profile, ...changes } }));
    $('chat-log').replaceChildren();
    fillProfile(info.profile);
    status('Saved. The assistant will use this from your next message.');
  } catch (e) { status(e.message, true); }
}

for (const k of ['dayStart', 'dayEnd', 'lunchStart', 'lunchEnd', 'focusTime']) {
  $(`pf-${k}`).addEventListener('change', (e) => saveProfile({ [k]: e.target.value }));
}
for (const k of ['blockMinutes', 'maxBlockMinutes', 'breakMinutes', 'meetingBuffer']) {
  $(`pf-${k}`).addEventListener('change', (e) => saveProfile({ [k]: Number(e.target.value) }));
}
$('pf-notes').addEventListener('input', () => { $('pf-notes-count').textContent = `${$('pf-notes').value.length} / 1500`; });
$('pf-notes').addEventListener('change', () => saveProfile({ notes: $('pf-notes').value }));

/** "Last message ≈ $0.0011 · This month ≈ $0.04 (37 messages)". */
function showUsage(u) {
  if (!u) { $('s-usage').textContent = 'No messages yet this month.'; return; }
  const money = (v) => (v == null ? null : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
  const tokens = (t) => `${(t.input + t.cacheWrite + t.cacheRead).toLocaleString()} in (${t.cacheRead.toLocaleString()} from cache) · ${t.output.toLocaleString()} out`;
  const last = u.last ? `Last message ≈ ${money(u.last.cost) ?? tokens(u.last)}` : '';
  const month = `This month ≈ ${u.cost ? money(u.cost) : tokens(u.tokens)} (${u.messages} message${u.messages === 1 ? '' : 's'})`;
  $('s-usage').textContent = [last, month].filter(Boolean).join(' · ');
}

function setModelMsg(text, isError = false, isOk = false) {
  $('s-model-msg').textContent = text;
  $('s-model-msg').className = `srow-desc ${isError ? 'error-text' : isOk ? 'ok-text' : ''}`;
}

/** Save provider/model/server changes, clear the chat, and redraw the section. */
async function saveAssistant(changes, label) {
  try {
    unwrap(await desk.chatSetSettings(changes));
    $('chat-log').replaceChildren();
    if (label) status(label);
  } catch (e) {
    status(e.message, true);
  }
  await fillAssistant();
}

$('s-provider').onchange = () => saveAssistant({ provider: $('s-provider').value },
  `Assistant now uses ${$('s-provider').selectedOptions[0].text}`);
$('p-assistantModel').onchange = () => saveAssistant({ model: $('p-assistantModel').value },
  `Assistant now uses ${$('p-assistantModel').selectedOptions[0].text.split(' — ')[0]}`);
$('s-model').onchange = () => saveAssistant({ model: $('s-model').value }, `Assistant model set to ${$('s-model').value.trim()}`);
$('s-baseurl').onchange = () => saveAssistant({ baseUrl: $('s-baseurl').value }, 'Server address saved');

// Asks the server for its model list; doubles as a connection + key test.
$('btn-load-models').onclick = async () => {
  setModelMsg('Asking the server…');
  try {
    const ids = unwrap(await desk.chatFetchModels());
    $('s-model-list').replaceChildren(...ids.map((id) => new Option(id, id)));
    setModelMsg(ids.length
      ? `✔ Connected. ${ids.length} model${ids.length === 1 ? '' : 's'} available: click the box to pick one.`
      : '✔ Connected, but the server listed no models.', false, true);
    if (ids.length) { $('s-model').focus(); try { $('s-model').showPicker(); } catch { /* needs a real click */ } }
  } catch (e) {
    setModelMsg(e.message, true);
  }
};

$('btn-save-key').onclick = async () => {
  const key = $('s-key').value.trim();
  if (!key) return;
  try {
    unwrap(await desk.chatSetKey(key));
    $('s-key').value = '';
    $('s-key-status').textContent = `✔ Saved (encrypted with ${SECRET_HOME}).`;
  } catch (e) { $('s-key-status').textContent = e.message; }
};

$('btn-signout').onclick = async () => {
  await desk.signOut();
  $('settings-page').hidden = true;
  $('toolbar').hidden = false;
  $('workspace').hidden = false;
  state.events = []; state.soonEvents = [];
  showSetup('Signed out.');
};

$('btn-replace-creds').onclick = async () => {
  try {
    if (unwrap(await desk.importCredentials())) status('New credentials.json loaded. Sign out and back in to use it.');
  } catch (e) { status(e.message, true); }
};

// ============================================================================
// Account → Phone app: settings shared with the iPhone app (src/main/sync.js)
// ============================================================================

async function fillSync() {
  const st = unwrap(await desk.syncStatus());
  if (document.activeElement !== $('s-sync-url')) $('s-sync-url').value = st.url;
  $('btn-sync-link').textContent = st.url ? 'Save' : 'Link';
  $('s-sync-actions').hidden = !st.url;
  const desc = $('s-sync-status');
  desc.classList.toggle('error-text', !!st.error);
  desc.textContent = st.error ? st.error
    : !st.url ? 'Not linked'
      : st.lastAt ? `Linked · synced ${fmtTime(new Date(st.lastAt))}` : 'Linking…';
}

$('btn-sync-link').onclick = async () => {
  $('s-sync-status').textContent = 'Linking…';
  try {
    unwrap(await desk.syncSetUrl($('s-sync-url').value));
  } catch (err) { status(err.message, true); }
  fillSync();
};
$('btn-sync-now').onclick = async () => {
  $('s-sync-status').textContent = 'Syncing…';
  try { unwrap(await desk.syncNow()); } catch (err) { status(err.message, true); }
  fillSync();
};
$('btn-sync-unlink').onclick = async () => {
  $('s-sync-url').value = '';
  try { unwrap(await desk.syncSetUrl('')); } catch (err) { status(err.message, true); }
  fillSync();
};
