// windowManager.js: creates the main window and remembers its size/position/maximized state.
//
// LOOK
//  Windows:
//  • titleBarStyle 'hidden' + titleBarOverlay: Windows draws its own minimize / maximize /
//    close buttons in the top-right (so you get the Windows 11 Snap Layouts flyout when you
//    hover maximize, Win+arrow snapping, and double-click-to-maximize). Our page draws
//    everything else in that 36 px strip.
//  • backgroundMaterial 'mica': Windows 11's tinted, wallpaper-aware background. The page's
//    body is transparent so Mica shows through; cards and dialogs stay solid for readability.
//    On Windows 10 / older Windows 11 we fall back to the solid dark background.
//  macOS:
//  • titleBarStyle 'hidden' keeps the red / yellow / green buttons, placed at the left of the
//    same 36 px strip (the page leaves room for them).
//  • vibrancy 'under-window': the Mac's translucent dark material, used the same way as Mica.
//
// CLOSE = HIDE
//  Clicking × hides the window to the tray (Windows) or menu bar (Mac) instead of quitting.
//  Quit from that icon's menu, or with Cmd+Q on a Mac.

const { app, BrowserWindow, Notification, nativeTheme, screen, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const prefs = require('./prefs');

const DEFAULT_SIZE = { width: 1200, height: 800 };
const MIN_SIZE = { width: 760, height: 520 };
const TITLEBAR_HEIGHT = 36;
const SOLID_BG = '#0f1115'; // same as --bg in styles.css
const ICON = path.join(__dirname, '..', 'assets', 'icon-256.png');

const IS_MAC = process.platform === 'darwin';
// Mica needs Windows 11 22H2 (build 22621) or newer.
const SUPPORTS_MICA = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
// See-through page background: Mica on Windows 11, vibrancy on every Mac.
const TRANSLUCENT = SUPPORTS_MICA || IS_MAC;

// The app's own page. The window never shows anything else, and main.js only answers
// requests that come from it.
const PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
/** Compare file paths the way the OS does (Windows and macOS ignore letter case). */
const samePath = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
/** True for the app's page (with or without ?query / #hash), however the URL is spelled. */
function isAppPage(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    return samePath(path.normalize(fileURLToPath(url.split(/[?#]/)[0])), path.normalize(PAGE));
  } catch {
    return false;
  }
}
// Browser permissions the page may use: copying a Meet link. Everything else (camera,
// microphone, location, notifications from the page…) is refused.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

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
  try { prefs.writeFileAtomic(stateFile(), JSON.stringify(state)); } catch (err) { console.error('[window state]', err.message); }
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
    ...(IS_MAC
      ? {
        // Traffic lights vertically centred in the 36 px title bar.
        trafficLightPosition: { x: 14, y: 12 },
        vibrancy: 'under-window', visualEffectState: 'followWindow', backgroundColor: '#00000000',
      }
      : {
        titleBarOverlay: {
          color: SUPPORTS_MICA ? '#00000000' : SOLID_BG, // transparent over Mica
          symbolColor: '#e6e8ee',
          height: TITLEBAR_HEIGHT,
        },
        ...(SUPPORTS_MICA
          ? { backgroundMaterial: 'mica', backgroundColor: '#00000000' }
          : { backgroundColor: SOLID_BG }),
      }),
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
  win.loadFile(PAGE, {
    query: { mica: TRANSLUCENT ? '1' : '0' },
  });

  // Mac full screen hides the traffic lights, so the page can drop the room it keeps for them.
  if (IS_MAC) {
    win.on('enter-full-screen', () => win.webContents.send('app:fullscreen', true));
    win.on('leave-full-screen', () => win.webContents.send('app:fullscreen', false));
  }

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
    // A full-screen Mac window has to leave full screen before it can hide cleanly.
    if (IS_MAC && win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
    showTrayHintOnce();
  });

  // Any link the page tries to open goes to your real browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window itself never leaves the app's page (a link or file dropped on it, a stray
  // redirect): another page would otherwise get the app's backend functions.
  const stay = (e, url) => { if (!isAppPage(url)) e.preventDefault(); };
  win.webContents.on('will-navigate', stay);
  win.webContents.on('will-redirect', stay);
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  return win;
}

function showTrayHintOnce() {
  if (prefs.get('trayHintShown') || !Notification.isSupported()) return;
  new Notification({
    title: 'Desk Calendar',
    body: IS_MAC
      ? 'Desk Calendar is still running in the menu bar. Quit with Cmd+Q.'
      : 'Desk Calendar is still running in the tray.',
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
  isAppPage,
  SUPPORTS_MICA,
  IS_MAC,
};
