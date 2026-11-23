// background.js: everything that keeps working while the window is hidden:
//   • the tray icon (Windows: left-click show/hide, right-click menu) or menu bar icon (Mac)
//   • the global show/hide hotkey (default Ctrl+Shift+Space, Cmd+Shift+Space on a Mac)
//   • starting when you sign in to Windows / log in to the Mac
// (Event notifications will join these in a later phase.)

const { app, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const prefs = require('./prefs');
const windowManager = require('./windowManager');

const ASSETS = path.join(__dirname, '..', 'assets');
const IS_MAC = process.platform === 'darwin';
let tray = null;
let activeHotkey = null;

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  let icon;
  if (IS_MAC) {
    // The Mac menu bar wants a black-and-transparent "template" image; macOS recolours it for
    // light / dark menu bars. Electron picks up trayTemplate@2x.png for Retina by itself.
    icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    icon.setTemplateImage(true);
  } else {
    // 16 px icon, plus a 32 px version for 200% display scaling so it stays sharp.
    icon = nativeImage.createFromPath(path.join(ASSETS, 'icon-16.png'));
    icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(ASSETS, 'icon-32.png')) });
  }

  tray = new Tray(icon);
  tray.setToolTip('Desk Calendar');
  // Windows: left-click shows/hides. On a Mac a click opens the menu below instead (the usual
  // menu bar behaviour), and the Dock icon brings the window back.
  if (!IS_MAC) tray.on('click', () => windowManager.toggle());
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

/** 'CommandOrControl+Shift+Space' → 'Ctrl+Shift+Space' (Windows) or 'Cmd+Shift+Space' (Mac). */
const pretty = (acc) => (IS_MAC
  ? acc.replace('CommandOrControl', 'Cmd').replace('Control', 'Ctrl').replace('Alt', 'Option')
  : acc.replace('CommandOrControl', 'Ctrl'));

// ---------------------------------------------------------------------------
// Start at sign-in / login
// ---------------------------------------------------------------------------

/**
 * Register/unregister the app to launch when you sign in to Windows or log in to the Mac.
 * On Windows it's launched with --hidden so it can start straight into the tray.
 * Only for the installed app: in development (npm start) this would register
 * Electron itself, so it's skipped. (The pref keeps its old name, startWithWindows.)
 */
function applyStartWithWindows(enabled) {
  if (!app.isPackaged) return { ok: true, skipped: true };
  app.setLoginItemSettings(IS_MAC ? { openAtLogin: enabled } : { openAtLogin: enabled, args: ['--hidden'] });
  return { ok: true };
}

/** Started by the system at sign-in (rather than by you)? */
function launchedAtLogin() {
  if (process.argv.includes('--hidden')) return true;
  if (!IS_MAC) return false;
  try { return Boolean(app.getLoginItemSettings().wasOpenedAtLogin); } catch { return false; }
}

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
