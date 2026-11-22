// background.js: everything that keeps working while the window is hidden:
//   • the tray icon (left-click show/hide, right-click menu)
//   • the global show/hide hotkey (default Ctrl+Shift+Space)
//   • starting with Windows
// (Event notifications will join these in a later phase.)

const { app, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const prefs = require('./prefs');
const windowManager = require('./windowManager');

const ASSETS = path.join(__dirname, '..', 'assets');
let tray = null;
let activeHotkey = null;

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  // 16 px icon, plus a 32 px version for 200% display scaling so it stays sharp.
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'icon-16.png'));
  icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(ASSETS, 'icon-32.png')) });

  tray = new Tray(icon);
  tray.setToolTip('Desk Calendar');
  tray.on('click', () => windowManager.toggle());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Desk Calendar', click: () => windowManager.show() },
    { label: 'New event', click: () => windowManager.command('new-event') },
    { label: 'Refresh', click: () => windowManager.command('refresh') },
    { label: 'Settings', click: () => windowManager.command('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => { windowManager.setQuitting(); app.quit(); } },
  ]));
}

// ---------------------------------------------------------------------------
// Global hotkey
// ---------------------------------------------------------------------------

/**
 * Register `accelerator` (e.g. 'CommandOrControl+Shift+Space') as the show/hide hotkey.
 * Returns { ok: true } or { ok: false, error } if it's invalid or another app owns it.
 * On failure the previous hotkey stays active.
 */
function setHotkey(accelerator) {
  const previous = activeHotkey;
  if (previous) globalShortcut.unregister(previous);
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, () => windowManager.toggle());
  } catch {
    if (previous) globalShortcut.register(previous, () => windowManager.toggle());
    return { ok: false, error: `"${pretty(accelerator)}" isn't a valid shortcut.` };
  }
  if (!ok) {
    if (previous) globalShortcut.register(previous, () => windowManager.toggle());
    return { ok: false, error: `${pretty(accelerator)} is already used by another app. Pick a different shortcut.` };
  }
  activeHotkey = accelerator;
  return { ok: true };
}

const pretty = (acc) => acc.replace('CommandOrControl', 'Ctrl');

// ---------------------------------------------------------------------------
// Start with Windows
// ---------------------------------------------------------------------------

/**
 * Register/unregister the app to launch at Windows sign-in. It's launched with
 * --hidden so it can start straight into the tray.
 * Only for the installed app: in development (npm start) this would register
 * electron.exe itself, so it's skipped.
 */
function applyStartWithWindows(enabled) {
  if (!app.isPackaged) return { ok: true, skipped: true };
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  return { ok: true };
}

const launchedAtLogin = () => process.argv.includes('--hidden');

// ---------------------------------------------------------------------------

/** Called once at startup. Returns the hotkey result so the UI can warn if it failed. */
function start() {
  createTray();
  applyStartWithWindows(prefs.get('startWithWindows'));
  const hotkey = setHotkey(prefs.get('hotkey'));
  if (!hotkey.ok) console.warn('Hotkey not registered:', hotkey.error);
  app.on('will-quit', () => globalShortcut.unregisterAll());
  return { hotkey };
}

module.exports = { start, setHotkey, applyStartWithWindows, launchedAtLogin, pretty };
