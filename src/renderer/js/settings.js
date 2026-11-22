// settings.js: the Settings page (General · Calendars · Assistant · Account).
//
// Every control saves immediately (no "Save" button), like Windows Settings.
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

// Shortcut recorder: click the box, press e.g. Ctrl+Alt+K. Esc cancels.
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
    $('s-hotkey').value = accel.replace('CommandOrControl', 'Ctrl');
    setHotkeyMsg('✔ Shortcut saved.', false, true);
  } catch (err) {
    $('s-hotkey').value = hotkeyBefore;
    setHotkeyMsg(err.message, true);
  }
});

/** Turn a keydown event into an Electron accelerator, e.g. 'CommandOrControl+Shift+Space'.
 *  Needs at least one of Ctrl/Alt plus a normal key, so it can't clash with typing. */
function toAccelerator(e) {
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
  let key = named[e.key];
  if (!key && /^F\d{1,2}$/.test(e.key)) key = e.key;
  if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);   // layout-independent letters
  if (!key && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
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
    ? '✔ A key is saved (encrypted with your Windows account). Paste a new one to replace it.'
    : info.keyFromEnv ? `Using the ${info.keyEnv} environment variable.`
    : p.keyRequired ? 'No key saved yet.' : 'Only needed if your server checks keys.';
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
    $('s-key-status').textContent = '✔ Saved (encrypted with your Windows account).';
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
