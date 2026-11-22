// make-mobile-icons.cjs: renders src/assets/icon.svg into the PNG icons the iPhone app needs.
// Run from the worker folder with:  npm run icons
// (uses the root project's Electron as an SVG rasterizer, like scripts/make-icons.js)
//
// Outputs (mobile/img/):
//   apple-touch-icon.png  180×180  Home Screen icon on iPhone
//   icon-192.png          192×192  web manifest
//   icon-512.png          512×512  web manifest (also used for "maskable")
//
// iPhone draws the rounded corners itself and paints any transparent pixels black,
// so these icons are FULL-BLEED: the blue tile fills the whole square. The calendar
// artwork already sits inside the central "safe zone" that every icon mask keeps.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'mobile', 'img');
const SVG = fs.readFileSync(path.join(ROOT, 'src/assets/icon.svg'), 'utf8')
  // the rounded tile → a square that fills the canvas
  .replace(/<rect x="16" y="16" width="224" height="224" rx="52"/, '<rect x="0" y="0" width="256" height="256"');

app.disableHardwareAcceleration();

async function renderMaster(S) {
  const win = new BrowserWindow({ width: S, height: S, show: false, frame: false, useContentSize: true,
    webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:#5d86f0;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}" width="${S}" height="${S}"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: S, height: S });
  win.destroy();
  return img.resize({ width: S, height: S, quality: 'best' });
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const master = await renderMaster(512);
  const write = (name, size) => fs.writeFileSync(path.join(OUT, name), master.resize({ width: size, height: size, quality: 'best' }).toPNG());
  write('apple-touch-icon.png', 180);
  write('icon-192.png', 192);
  write('icon-512.png', 512);
  console.log('Mobile icons written to mobile/img/.');
  app.quit();
});
