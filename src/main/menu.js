// menu.js: the Mac menu bar (Desk Calendar · File · Edit · View · Window).
//
// Only used on macOS. A Mac app needs this menu for more than looks: Cmd+C / Cmd+V / Cmd+Z in
// text boxes, Cmd+Q, Cmd+W and Cmd+H all come from it. Windows has no menu bar here (the title
// bar is drawn by the page), so nothing changes there.

const { app, Menu } = require('electron');
const windowManager = require('./windowManager');

function setMacMenu() {
  const cmd = (name) => () => windowManager.command(name);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Desk Calendar',
      submenu: [
        { role: 'about', label: 'About Desk Calendar' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: cmd('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Desk Calendar' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Desk Calendar' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Event', accelerator: 'Cmd+N', click: cmd('new-event') },
        { label: 'Refresh', accelerator: 'Cmd+R', click: cmd('refresh') },
        { type: 'separator' },
        { role: 'close' }, // Cmd+W: hides the window, like the red button
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
  ]));
}

module.exports = { setMacMenu };
