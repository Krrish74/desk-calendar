// app.js: startup, sign-in screen, title bar, keyboard shortcuts and timers (loaded last).

// Mica (Windows 11) or vibrancy (Mac): the backend loads us with ?mica=1, so the page goes see-through.
if (new URLSearchParams(location.search).get('mica') === '1') document.documentElement.classList.add('mica');

// On a Mac: leave room for the red/yellow/green buttons, and use Mac wording. Elements with a
// data-mac attribute swap their text for it (e.g. "Start with Windows" → "Open at login").
if (IS_MAC) {
  document.documentElement.classList.add('mac');
  for (const el of document.querySelectorAll('[data-mac]')) el.textContent = el.dataset.mac;
  desk.onFullscreen((on) => document.documentElement.classList.toggle('fullscreen', on));
}

// ============================================================================
// Startup and sign-in
// ============================================================================

async function init() {
  try {
    await start();
  } catch (err) {
    // Something failed while starting: show the sign-in screen with the reason, not a blank window.
    showSetup(err.message);
  }
}

async function start() {
  setPinIcon(unwrap(await desk.isPinned()));
  const { prefs } = unwrap(await desk.getPrefs());
  state.prefs = prefs;
  // Settings → Start in: the last-used view, or a fixed one.
  state.view = prefs.startView === 'last' ? prefs.view : prefs.startView;
  applyPrefs();
  sidebarPref = prefs.sidebarCollapsed;
  applySidebar();

  const s = unwrap(await desk.authStatus());
  if (s.signedIn) showApp();
  else showSetup();
}

function showSetup(message = '') {
  desk.authStatus().then((r) => {
    const hasCreds = r.data?.hasCredentials;
    $('setup-creds').style.opacity = hasCreds ? 0.55 : 1;
    $('btn-load-creds').textContent = hasCreds ? 'Replace credentials.json…' : 'Load credentials.json…';
    $('btn-signin').disabled = !hasCreds;
  });
  $('setup-msg').textContent = message;
  $('app').hidden = true;
  $('setup').hidden = false;
}

function showApp() {
  $('setup').hidden = true;
  $('app').hidden = false;
  refreshScreen();
  loadCalendars();
}

$('btn-load-creds').onclick = async () => {
  try {
    if (unwrap(await desk.importCredentials())) showSetup('credentials.json loaded ✔ Now sign in.');
  } catch (e) { $('setup-msg').textContent = e.message; }
};

let signInWaiting = false;
$('btn-signin').onclick = async () => {
  // Already waiting (the browser tab may have been closed): the main process opens the
  // same Google page again; the first click's handler finishes the sign-in.
  if (signInWaiting) { desk.signIn(); return; }
  signInWaiting = true;
  $('setup-msg').textContent = 'Waiting for you to finish in the browser… (closed the tab? Click Sign in again.)';
  try {
    unwrap(await desk.signIn());
    showApp();
  } catch (e) {
    $('setup-msg').textContent = 'Sign-in failed: ' + e.message;
  } finally {
    signInWaiting = false;
  }
};

const signedIn = () => !$('app').hidden;

// Settings changed on the phone (shared through the phone app, see src/main/sync.js):
// pick them up and redraw. Settings → Account → Phone app links the two.
desk.onPrefsChanged(async () => {
  try {
    const { prefs } = unwrap(await desk.getPrefs());
    state.prefs = prefs;
    applyPrefs();
    if (!signedIn()) return;
    loadCalendars();
    refreshScreen();
    if (!$('settings-page').hidden) fillSettings();
  } catch (err) { status(err.message, true); }
});

// Google refused a delete after its Undo window (e.g. no permission): the item comes back.
desk.onDeleteFailed(({ title, isTask, error }) => {
  status(`Couldn't delete ${isTask ? 'task' : 'event'}${title ? ` “${title}”` : ''}: ${error}`, true);
  loadEvents();
});

// Dropping a file or link on the window must not open it in place of the app.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });
}

/** Apply preferences that change how things are drawn (called after Settings changes). */
function applyPrefs() {
  state.weekStartsOn = state.prefs.weekStartsOn;
}

// ============================================================================
// Title bar
// ============================================================================

function setPinIcon(pinned) {
  $('btn-pin').classList.toggle('active', pinned);
  $('btn-pin').querySelector('.ico').className = `ico ${pinned ? 'i-pin-filled' : 'i-pin'}`;
  $('btn-pin').title = pinned ? 'Keep on top: on' : 'Keep on top: off';
}
$('btn-pin').onclick = async () => setPinIcon(unwrap(await desk.togglePin()));

// ============================================================================
// Tray menu commands and keyboard shortcuts
// ============================================================================

desk.onCommand((name, payload) => {
  if (!signedIn()) return; // not signed in yet: just showing the window is enough
  if (name === 'refresh') { loadCalendars(); loadEvents(); }
  // Tray "New event": don't throw away an editor that's already open.
  if (name === 'new-event' && !$('editor').open) openEditor(null);
  if (name === 'settings') openSettings();
  if (name === 'show-event') {
    // Clicked a notification: go to that event's day and flash it.
    if (!$('settings-page').hidden) closeSettings();
    state.highlightId = payload.id;
    goToDate(new Date(payload.start));
  }
});

// Google Calendar's keys: D/W/M/A views, T today, J/K or ←/→ next/previous, C create.
document.addEventListener('keydown', (e) => {
  if (!signedIn() || e.ctrlKey || e.altKey || e.metaKey || !$('settings-page').hidden) return;
  if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  const views = { d: 'day', w: 'week', m: 'month', a: 'agenda' };
  const k = e.key.toLowerCase();
  if (views[k]) setView(views[k]);
  else if (k === 't') goToday();
  else if (k === 'j' || e.key === 'ArrowRight') step(1);
  else if (k === 'k' || e.key === 'ArrowLeft') step(-1);
  else if (k === 'c') openEditor(null);
  else return;
  e.preventDefault();
});

// ============================================================================
// Timers
// ============================================================================

setInterval(tickCountdown, 1000);
setInterval(() => { if (signedIn() && !document.body.classList.contains('dragging')) loadEvents(); }, REFRESH_MINUTES * 60 * 1000);
// Coming back to the window after a while? Refresh if the data is over a minute old.
window.addEventListener('focus', () => {
  if (signedIn() && Date.now() - state.lastLoaded > 60 * 1000) loadEvents();
});
// The backend pings us when the assistant changed something (see chat.js).

init();
