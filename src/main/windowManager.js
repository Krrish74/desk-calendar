// windowManager.js: creates the main window and remembers its size/position/maximized state.
//
// LOOK
//  • titleBarStyle 'hidden' + titleBarOverlay: Windows draws its own minimize / maximize /
//    close buttons in the top-right (so you get the Windows 11 Snap Layouts flyout when you
//    hover maximize, Win+arrow snapping, and double-click-to-maximize). Our page draws
//    everything else in that 36 px strip.
//  • backgroundMaterial 'mica': Windows 11's tinted, wallpaper-aware background. The page's
//    body is transparent so Mica shows through; cards and dialogs stay solid for readability.
//    On Windows 10 / older Windows 11 we fall back to the solid dark background.
//
// CLOSE = HIDE
//  Clicking × hides the window to the tray instead of quitting. Quit from the tray menu.

const { app, BrowserWindow, Notification, nativeTheme, screen, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prefs = require('./prefs');

const DEFAULT_SIZE = { width: 1200, height: 800 };
const MIN_SIZE = { width: 760, height: 520 };
const TITLEBAR_HEIGHT = 36;
const SOLID_BG = '#0f1115'; // same as --bg in styles.css
const ICON = path.join(__dirname, '..', 'assets', 'icon-256.png');

// Mica needs Windows 11 22H2 (build 22621) or newer.
const SUPPORTS_MICA = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;

let win = null;
let quitting = false; // true once the user really wants to quit (tray → Quit)

// ---------------------------------------------------------------------------
// Remembering size / position / maximized
// ---------------------------------------------------------------------------

const STATE_VERSION = 2; // bump to ignore window.json files from older layouts (v1 = small widget)
const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (s.v !== STATE_VERSION) return null;
    // Ignore a position that's no longer on any screen (e.g. a monitor was unplugged).
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      s.x < a.x + a.width - 100 && s.x + s.width > a.x + 100 && s.y >= a.y - 10 && s.y < a.y + a.height - 50);
    return visible ? s : { ...s, x: undefined, y: undefined };
  } catch {
    return null;
  }
}

function saveState() {
  if (!win || win.isMinimized()) return;
  // getNormalBounds = the size it returns to when un-maximized.
  const state = { v: STATE_VERSION, ...win.getNormalBounds(), maximized: win.isMaximized() };
  fs.writeFileSync(stateFile(), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Creating the window
// ---------------------------------------------------------------------------

function create({ startHidden = false } = {}) {
  nativeTheme.themeSource = 'dark'; // dark Mica, dark caption buttons, dark scrollbars

  const saved = loadState() || {};
  win = new BrowserWindow({
    width: saved.width || DEFAULT_SIZE.width,
    height: saved.height || DEFAULT_SIZE.height,
    x: saved.x,
    y: saved.y,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false, // shown once the page has painted (no white flash)
    title: 'Desk Calendar',
    icon: ICON,
    alwaysOnTop: prefs.get('alwaysOnTop'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: SUPPORTS_MICA ? '#00000000' : SOLID_BG, // transparent over Mica
      symbolColor: '#e6e8ee',
      height: TITLEBAR_HEIGHT,
    },
    ...(SUPPORTS_MICA
      ? { backgroundMaterial: 'mica', backgroundColor: '#00000000' }
      : { backgroundColor: SOLID_BG }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, // page JS can't touch preload/Node internals
      nodeIntegration: false, // page has no require()
      sandbox: true,
    },
  });

  // While developing, the app is electron.exe + this project folder. Tell Windows how to relaunch
  // it, so pinning the taskbar button opens Desk Calendar instead of Electron's blank demo window.
  // (The installed app is its own Desk Calendar.exe and doesn't need this.)
  if (process.platform === 'win32' && !app.isPackaged) {
    win.setAppDetails({
      appId: 'com.local.deskcalendar',
      relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Desk Calendar (dev)',
      appIconPath: path.join(app.getAppPath(), 'build', 'icon.ico'),
    });
  }

  // ?mica=1 tells the page to make its background transparent (see styles.css: html.mica).
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { mica: SUPPORTS_MICA ? '1' : '0' },
  });

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize();
    if (!startHidden) win.show();
  });

  // Save state (debounced) whenever it's moved, resized, maximized or restored.
  let saveTimer;
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 400); };
  for (const evt of ['move', 'resize', 'maximize', 'unmaximize']) win.on(evt, scheduleSave);

  // Windows is shutting down or signing out: let the window close.
  win.on('session-end', () => { quitting = true; });

  // × hides to the tray instead of quitting.
  win.on('close', (e) => {
    saveState();
    if (quitting) return;
    e.preventDefault();
    win.hide();
    showTrayHintOnce();
  });

  // Any link the page tries to open goes to your real browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

function showTrayHintOnce() {
  if (prefs.get('trayHintShown') || !Notification.isSupported()) return;
  new Notification({
    title: 'Desk Calendar',
    body: 'Desk Calendar is still running in the tray.',
    icon: ICON,
    silent: true,
  }).show();
  prefs.set({ trayHintShown: true });
}

// ---------------------------------------------------------------------------
// Show / hide helpers (used by the tray, the hotkey and second launches)
// ---------------------------------------------------------------------------

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Hotkey / tray click: hide if it's in front, otherwise bring it forward. */
function toggle() {
  if (!win) return;
  if (win.isVisible() && win.isFocused() && !win.isMinimized()) win.hide();
  else show();
}

/** Send a command to the page (e.g. 'new-event', 'refresh', 'settings', 'show-event'). */
function command(name, payload) {
  show();
  win.webContents.send('app:command', name, payload);
}

module.exports = {
  create, show, toggle, command,
  get: () => win,
  setQuitting: () => { quitting = true; },
  SUPPORTS_MICA,
};
